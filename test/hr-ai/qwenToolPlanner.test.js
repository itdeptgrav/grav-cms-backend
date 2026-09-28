"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const {
  planToolQuestion,
  validateArguments,
  groundEntityArguments,
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

test("invented entity filters are removed before any data read", () => {
  const schema = {
    type: "object",
    properties: {
      employeeName: { type: "string" },
      department: { type: "string" },
      limit: { type: "integer" },
    },
  };
  expect(groundEntityArguments(
    { employeeName: "John Doe", department: "Human Resources", limit: 10 },
    schema,
    "show everyone in HR",
    {},
  )).toEqual({ department: "Human Resources", limit: 10 });
});

test("an optional date is removed when the user asked for no period", () => {
  const schema = {
    type: "object",
    properties: {
      employeeName: { type: "string" },
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    },
    required: ["employeeName"],
  };
  expect(groundEntityArguments(
    { employeeName: "Arpita Das", date: "2026-09-27" },
    schema,
    "father of Arpita Das",
    {},
  )).toEqual({ employeeName: "Arpita Das" });
  expect(groundEntityArguments(
    { employeeName: "Arpita Das", date: "2026-09-26" },
    schema,
    "attendance of Arpita Das yesterday",
    {},
  )).toEqual({ employeeName: "Arpita Das", date: "2026-09-26" });
});

test("a hallucinated required person fails closed but validated follow-up state is allowed", () => {
  const schema = {
    type: "object",
    properties: { employeeName: { type: "string" } },
    required: ["employeeName"],
  };
  expect(groundEntityArguments({ employeeName: "John Doe" }, schema, "show the employee", {})).toBeNull();
  expect(groundEntityArguments(
    { employeeName: "Priya Shah" },
    schema,
    "what about their attendance?",
    { previousPlan: { arguments: { employeeName: "Priya Shah" } } },
  )).toEqual({ employeeName: "Priya Shah" });
});

test("the route contract treats a relationship of a named person as a person-record request", async () => {
  const employeeTool = {
    name: "hr_employee",
    description: "Complete authorised record for one named employee, including family fields.",
    parameters: {
      type: "object",
      properties: {
        employeeName: { type: "string" },
        requestedField: { type: "string", enum: ["fatherName", "primaryManager", "fullRecord"] },
      },
      required: ["employeeName", "requestedField"],
    },
  };
  const calls = [];
  const ask = jest.fn(async (request) => {
    calls.push(request);
    if (request.schema.properties.choice) {
      return { model: "qwen-test", data: { choice: "hr_employee", clarification: null } };
    }
    return { model: "qwen-test", data: { employeeName: "Arpita Das", requestedField: "fatherName" } };
  });
  const result = await planToolQuestion(
    { question: "father of Arpita Das", tools: [employeeTool] },
    { chatJson: ask },
  );
  expect(result).toMatchObject({
    status: STATUS.OK,
    tool: "hr_employee",
    arguments: { employeeName: "Arpita Das", requestedField: "fatherName" },
  });
  expect(calls[0].system).toContain("parent");
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
