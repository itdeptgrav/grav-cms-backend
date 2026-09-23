"use strict";
/**
 * Open-Jev routing pilot — adapter contract, fallback and authority order.
 *
 * These are CONTRACT tests of GRAV's side. The Open-Jev "server" below is a
 * hand-written HTTP double returning well-formed and malformed bodies so GRAV's
 * validation and fallback can be pinned. It is not a model and says nothing
 * about Open-Jev's accuracy — that is scripts/open-jev-pilot/evaluate.js, which
 * reports live inference as blocked when no compatible host is reachable.
 *
 * Pinned:
 *   • flag off (default) → no network call, existing path untouched;
 *   • the request carries only the question and the offered intents;
 *   • an unauthorised user is never offered attendance_today, and no call is made;
 *   • unavailable / timeout / invalid / low-confidence / unclear → null (fallback);
 *   • a routed intent is re-authorised independently of the model;
 *   • GRAV's own question rules can refuse a route (other day, group, leave);
 *   • the reply is built from the evidence packet, never from a probability;
 *   • gravAssistant.chat returns the pilot answer through the same shape.
 */

process.env.TEST_WITHOUT_MONGO = "1";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../services/ollamaClient", () => {
  const actual = jest.requireActual("../../services/ollamaClient");
  return {
    ...actual,
    chatJson: jest.fn().mockResolvedValue({ data: { reply: "BASELINE_REPLY" }, model: "qwen3:8b" }),
    chatWithTools: jest.fn().mockResolvedValue({ toolCalls: [], content: "BASELINE_DIRECT" }),
  };
});

// The HR context builders are never reached here (no tool runs); they are
// mocked only so registering the HR tools does not load their route graph —
// the same approach as centralAssistant.route.test.js.
jest.mock("../../services/hrOverviewContext", () => ({ buildHrOverviewContext: jest.fn() }));
jest.mock("../../services/dailyAttendanceContext", () => ({ buildDailyAttendanceContext: jest.fn() }));
jest.mock("../../services/hrLeaveContext", () => ({ buildLeaveContext: jest.fn() }));

const { tryOpenJevPilot } = require("../../services/ai/openJev/pilot");
const { validateChoiceResponse } = require("../../services/ai/openJev/openJevClient");
const { openJevConfig } = require("../../services/ai/openJev/config");
const { OUTCOME, analyseQuestion } = require("../../services/ai/openJev/attendanceToday");
require("../../services/ai/tools/hrTools");
const { NOW, ACTORS, fixturePorts } = require("../../scripts/open-jev-pilot/fixtures");

const ENABLED = openJevConfig({ GRAV_OPEN_JEV_PILOT_ENABLED: "true" });

function jevBody(probabilities, extra = {}) {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return {
    answers: { route: { type: "choice", choice, probabilities, confidence: 0.5 } },
    model: "Open-Jev-2B-test-double",
    usage: { input_tokens: 10, output_tokens: 0 },
    metadata: { method: "checkpoint", temperature: 1.2, provenance: { checkpoint_sha256: "abc" } },
    ...extra,
  };
}

function fakeFetch(respond) {
  const calls = [];
  const fn = jest.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return respond(body, init);
  });
  fn.calls = calls;
  return fn;
}
const okJson = (obj) => ({ ok: true, status: 200, json: async () => obj });

const ATT_CONFIDENT = { attendance_today: 0.93, leave_today: 0.03, other: 0.03, unclear: 0.01 };

async function run(message, { actor = "hr_viewer_A", scenario = "normal", fetchImpl, config = ENABLED, user } = {}) {
  const u = user || ACTORS[actor]();
  const ports = fixturePorts({ companyId: u.companyId, scenario });
  const logs = [];
  const result = await tryOpenJevPilot(
    { user: u, message, ensureAccess: async () => {} },
    { config, fetchImpl, ports, now: () => NOW, log: (route, extra) => logs.push({ route, extra }) },
  );
  return { result, ports, logs, user: u };
}

describe("flag", () => {
  test("disabled by default: no call, null result", async () => {
    const f = fakeFetch(() => okJson(jevBody(ATT_CONFIDENT)));
    const { result, ports } = await run("Is Rishee present today?", { fetchImpl: f, config: openJevConfig({}) });
    expect(result).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(ports.reads.directory).toBe(0);
  });

  test("only the literal string true enables it", () => {
    expect(openJevConfig({ GRAV_OPEN_JEV_PILOT_ENABLED: "1" }).enabled).toBe(false);
    expect(openJevConfig({ GRAV_OPEN_JEV_PILOT_ENABLED: "TRUE" }).enabled).toBe(true);
  });
});

describe("what the model is given", () => {
  test("only the question and the offered intents — no data, no credentials", async () => {
    const f = fakeFetch(() => okJson(jevBody(ATT_CONFIDENT)));
    await run("Is Rishee present today?", { fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(1);
    const { body } = f.calls[0];
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.state).toEqual({ question: "Is Rishee present today?" });
    expect(Object.keys(body.questions)).toEqual(["route"]);
    expect(Object.keys(body.questions.route.criteria).sort()).toEqual(["attendance_today", "leave_today", "other", "unclear"]);
    const wire = JSON.stringify(body);
    for (const forbidden of ["mongodb", "MONGO", "password", "GR0101", "Ray", "dailyattendance", "employees"]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  test.each(["employee_self_A", "sales_only_A", "directory_only_A"])(
    "%s is never offered attendance_today and no call is made",
    async (actor) => {
      const f = fakeFetch(() => okJson(jevBody(ATT_CONFIDENT)));
      const { result, ports } = await run("Is Rishee present today?", { actor, fetchImpl: f });
      expect(result).toBeNull();
      expect(f).not.toHaveBeenCalled();
      expect(ports.reads.attendance).toEqual([]);
    },
  );
});

describe("clean fallback", () => {
  const cases = [
    ["network error", () => { throw Object.assign(new Error("ECONNREFUSED"), { name: "TypeError" }); }, "unavailable"],
    ["http 500", () => ({ ok: false, status: 500, json: async () => ({}) }), "unavailable"],
    ["non-JSON body", () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } }), "invalid"],
    ["choice not offered", () => okJson({ answers: { route: { type: "choice", choice: "hr_salary", probabilities: { ...ATT_CONFIDENT } } } }), "invalid"],
    ["probabilities do not sum to 1", () => okJson(jevBody({ attendance_today: 0.9, leave_today: 0.9, other: 0.1, unclear: 0.1 })), "invalid"],
    ["extra probability key", () => okJson(jevBody({ ...ATT_CONFIDENT, attendance_today: 0.83, hr_salary: 0.1 })), "invalid"],
    ["choice is not argmax", () => okJson({ answers: { route: { type: "choice", choice: "attendance_today", probabilities: { attendance_today: 0.2, leave_today: 0.1, other: 0.6, unclear: 0.1 } } } }), "invalid"],
    ["wrong question id", () => okJson({ answers: { other_q: { type: "choice", choice: "other", probabilities: ATT_CONFIDENT } } }), "invalid"],
    ["low confidence", () => okJson(jevBody({ attendance_today: 0.55, leave_today: 0.05, other: 0.35, unclear: 0.05 })), "abstain_low_confidence"],
    ["small margin", () => okJson(jevBody({ attendance_today: 0.62, leave_today: 0.0, other: 0.38, unclear: 0.0 })), "abstain_low_confidence"],
    ["unclear", () => okJson(jevBody({ attendance_today: 0.05, leave_today: 0.05, other: 0.05, unclear: 0.85 })), "abstain_unclear"],
    ["other", () => okJson(jevBody({ attendance_today: 0.05, leave_today: 0.05, other: 0.85, unclear: 0.05 })), "not_routable"],
    ["leave", () => okJson(jevBody({ attendance_today: 0.05, leave_today: 0.85, other: 0.05, unclear: 0.05 })), "not_routable"],
  ];
  test.each(cases)("%s → null, no attendance read", async (_name, respond, status) => {
    const { result, ports, logs } = await run("Is Rishee present today?", { fetchImpl: fakeFetch(respond) });
    expect(result).toBeNull();
    expect(ports.reads.attendance).toEqual([]);
    expect(logs[0].route.status).toBe(status);
  });

  test("timeout → null", async () => {
    const slow = jest.fn(
      (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const { result, logs } = await run("Is Rishee present today?", { fetchImpl: slow, config: { ...ENABLED, timeoutMs: 30 } });
    expect(result).toBeNull();
    expect(logs[0].route.status).toBe("timeout");
  });

  test("diagnostics never carry the message, a name or evidence", async () => {
    const { logs } = await run("Is Rishee present today?", { fetchImpl: fakeFetch(() => okJson(jevBody(ATT_CONFIDENT))) });
    const text = JSON.stringify(logs);
    expect(text).not.toMatch(/Rishee|Ray|GR0101|9:12/);
  });
});

describe("GRAV owns the answer", () => {
  const route = () => fakeFetch(() => okJson(jevBody(ATT_CONFIDENT)));

  test("accepted route → answer from the evidence packet, not the probability", async () => {
    const { result, ports } = await run("Is Rishee present today?", { fetchImpl: route() });
    expect(result.reply).toBe(
      "Rishee Ray checked in at 9:12 am today (2026-09-22). Recorded status: present (system prediction, not yet reviewed by HR).",
    );
    expect(result.reply).not.toMatch(/0\.9|93|probab|confiden/i);
    expect(result.toolsUsed).toEqual(["hr_attendance_today"]);
    expect(result.pilot.outcome).toBe(OUTCOME.CHECKED_IN);
    expect(ports.reads.attendance).toEqual(["GR0101"]);
  });

  test("terse form", async () => {
    const { result } = await run("Rishee present?", { fetchImpl: route() });
    expect(result.pilot.outcome).toBe(OUTCOME.CHECKED_IN);
  });

  test("model confidence cannot turn a missing record into presence", async () => {
    const { result } = await run("Is Ananya Das present today?", { fetchImpl: route() });
    expect(result.pilot.outcome).toBe(OUTCOME.NO_ENTRY);
    expect(result.reply).toMatch(/no attendance entry/i);
    expect(result.reply).not.toMatch(/checked in at/);
  });

  test("ambiguous name → clarification, no attendance read", async () => {
    const { result, ports } = await run("Is Priya present today?", { fetchImpl: route() });
    expect(result.pilot.outcome).toBe(OUTCOME.CLARIFY_AMBIGUOUS);
    expect(ports.reads.attendance).toEqual([]);
  });

  test("typo → confirmation question, no attendance read", async () => {
    const { result, ports } = await run("Is Umung present today?", { fetchImpl: route() });
    expect(result.pilot.outcome).toBe(OUTCOME.CLARIFY_CONFIRM);
    expect(ports.reads.attendance).toEqual([]);
  });

  test.each(["Was Rishee present yesterday?", "Who is present today?", "Am I present today?", "Is Rishee on leave today?"])(
    "GRAV refuses a mis-route for %p → null",
    async (msg) => {
      const { result, ports } = await run(msg, { fetchImpl: route() });
      expect(result).toBeNull();
      expect(ports.reads.attendance).toEqual([]);
    },
  );

  test("re-authorisation after the model is independent of it", async () => {
    const user = ACTORS.hr_viewer_A();
    // Permission is withdrawn while the model call is in flight.
    const f = fakeFetch(() => {
      user.hrActor.capabilities = new Set(["hr.access", "people.read.directory"]);
      return okJson(jevBody(ATT_CONFIDENT));
    });
    const { result, ports } = await run("Is Rishee present today?", { user, fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(ports.reads.attendance).toEqual([]);
  });

  test("cross-company: a person outside the caller's directory is never read", async () => {
    const { result, ports } = await run("Is Umang present today?", { actor: "hr_viewer_B", fetchImpl: route() });
    expect(result.pilot.outcome).toBe(OUTCOME.NOT_FOUND);
    expect(ports.reads.attendance).toEqual([]);
  });
});

describe("validateChoiceResponse", () => {
  test("accepts a well-formed answer", () => {
    expect(validateChoiceResponse(jevBody(ATT_CONFIDENT), Object.keys(ATT_CONFIDENT)).ok).toBe(true);
  });
  test("rejects NaN", () => {
    const b = jevBody(ATT_CONFIDENT);
    b.answers.route.probabilities.other = NaN;
    expect(validateChoiceResponse(b, Object.keys(ATT_CONFIDENT)).ok).toBe(false);
  });
});

describe("question analysis", () => {
  test("typos in cue words are not name tokens", () => {
    expect(analyseQuestion("Umang presnt todya?")).toMatchObject({ nameTokens: ["umang"], day: "today" });
    expect(analyseQuestion("Was Rishee present yesterdy?").day).toBe("other");
  });
});

describe("gravAssistant integration", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
    jest.restoreAllMocks();
  });

  function hrUser() {
    const u = ACTORS.hr_viewer_A();
    return { ...u, id: "u1" };
  }

  test("flag off: chat uses the existing path, no Open-Jev call", async () => {
    delete process.env.GRAV_OPEN_JEV_PILOT_ENABLED;
    const spy = jest.spyOn(globalThis, "fetch");
    const { chat } = require("../../services/ai/gravAssistant");
    const out = await chat({ user: hrUser(), message: "hello" });
    expect(out.reply).toBe("BASELINE_DIRECT");
    expect(spy.mock.calls.filter(([u]) => String(u).includes("8791"))).toHaveLength(0);
  });

  test("flag on + Open-Jev unreachable: chat still answers via the existing path", async () => {
    process.env.GRAV_OPEN_JEV_PILOT_ENABLED = "true";
    process.env.GRAV_OPEN_JEV_URL = "http://127.0.0.1:9/v1/systemone"; // discard port: refused
    jest.spyOn(console, "info").mockImplementation(() => {});
    const { chat } = require("../../services/ai/gravAssistant");
    const out = await chat({ user: hrUser(), message: "hello" });
    expect(out.reply).toBe("BASELINE_DIRECT");
  });
});
