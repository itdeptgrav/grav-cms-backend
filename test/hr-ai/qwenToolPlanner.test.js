"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const {
  planToolQuestion,
  validateArguments,
  recentContext,
  STATUS,
  CONTROL,
} = require("../../services/ai/qwenToolPlanner");

const tools = [
  {
    name: "hr_daily_attendance",
    description: "Whole-day attendance for a date and optional department.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        department: { type: "string", maxLength: 40 },
      },
      required: ["date"],
    },
  },
  {
    name: "hr_holidays",
    description: "Company holidays and dates.",
    parameters: { type: "object", properties: {} },
  },
];

test("Qwen sees only user language, safe capability descriptions and validated prior plan", async () => {
  const calls = [];
  const ask = jest.fn(async (request) => {
    calls.push(request);
    if (request.schema.properties.choice) {
      return { model: "qwen-test", data: { choice: "hr_daily_attendance", clarification: null } };
    }
    return { model: "qwen-test", data: { date: "2026-09-26", department: "Cutting" } };
  });
  const result = await planToolQuestion(
    {
      question: "who was absent yesterday in cutting?",
      tools,
      history: [
        { role: "user", content: "show attendance" },
        {
          role: "assistant",
          content: "sensitive answer text must not be copied into planning",
          toolsUsed: ["hr_daily_attendance"],
          contextState: { schema: "grav.assistant.plan/1", tool: "hr_daily_attendance", arguments: { date: "2026-09-25" } },
        },
      ],
    },
    { chatJson: ask },
  );
  expect(result).toMatchObject({
    status: STATUS.OK,
    tool: "hr_daily_attendance",
    arguments: { date: "2026-09-26", department: "Cutting" },
  });
  const modelInput = JSON.stringify(calls);
  expect(modelInput).toContain("Whole-day attendance");
  expect(modelInput).toContain("grav.assistant.plan/1");
  expect(modelInput).not.toContain("sensitive answer text");
  expect(modelInput).not.toMatch(/mongodb|connection string|credential/i);
});

test("a no-argument capability stops after the route decision", async () => {
  const ask = jest.fn(async () => ({ model: "qwen-test", data: { choice: "hr_holidays", clarification: null } }));
  const result = await planToolQuestion({ question: "next company holiday", tools }, { chatJson: ask });
  expect(result).toMatchObject({ status: STATUS.OK, tool: "hr_holidays", arguments: {} });
  expect(ask).toHaveBeenCalledTimes(1);
});

test("clarification is returned without executing a capability", async () => {
  const ask = jest.fn(async () => ({
    model: "qwen-test",
    data: { choice: CONTROL.CLARIFY, clarification: "Which employee do you mean?" },
  }));
  const result = await planToolQuestion({ question: "what is their attendance?", tools }, { chatJson: ask });
  expect(result).toMatchObject({ status: STATUS.OK, control: CONTROL.CLARIFY, clarification: "Which employee do you mean?" });
});

test("an unoffered capability is rejected", async () => {
  const ask = jest.fn(async () => ({ model: "qwen-test", data: { choice: "hr_salary", clarification: null } }));
  const result = await planToolQuestion({ question: "show salary", tools }, { chatJson: ask });
  expect(result).toMatchObject({ status: STATUS.INVALID, reason: "choice_not_offered" });
});

test("arguments fail closed on missing required, extra or invalid fields", () => {
  const schema = tools[0].parameters;
  expect(validateArguments({ date: "2026-09-26", department: "HR" }, schema)).toEqual({ date: "2026-09-26", department: "HR" });
  expect(validateArguments({ department: "HR" }, schema)).toBeNull();
  expect(validateArguments({ date: "26/09/2026" }, schema)).toBeNull();
  expect(validateArguments({ date: "2026-09-26", database: "employees" }, schema)).toBeNull();
});

test("recent context contains user words and validated state, never assistant prose", () => {
  const context = recentContext([
    { role: "user", content: "who was absent yesterday" },
    {
      role: "assistant",
      content: "Asha was absent",
      toolsUsed: ["hr_daily_attendance"],
      contextState: { schema: "grav.assistant.plan/1", tool: "hr_daily_attendance", arguments: { date: "2026-09-25" } },
    },
  ]);
  expect(context.previousUserMessages).toEqual(["who was absent yesterday"]);
  expect(context.previousPlan.tool).toBe("hr_daily_attendance");
  expect(JSON.stringify(context)).not.toContain("Asha was absent");
});
