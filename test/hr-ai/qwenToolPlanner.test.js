"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const {
  planToolQuestion,
  validateArguments,
  removeOptionalPlaceholders,
  groundEntityArguments,
  recentContext,
  prepareArgumentContract,
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

test("a complete request does not expose stale validated plan state to Qwen", async () => {
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
  expect(modelInput).not.toContain("grav.assistant.plan/1");
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

test("model placeholders are removed only from optional fields that do not allow them", () => {
  const schema = {
    type: "object",
    properties: {
      metric: { type: "string", enum: ["__none__", "status"] },
      from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      query: { type: "string" },
    },
    required: ["metric"],
  };
  expect(removeOptionalPlaceholders(
    { metric: "__none__", from: "__none__", query: null },
    schema,
  )).toEqual({ metric: "__none__" });
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

test("an invented generic business subject is removed before any data read", () => {
  const schema = {
    type: "object",
    properties: { metric: { type: "string" }, subject: { type: "string" } },
    required: ["metric"],
  };
  expect(groundEntityArguments(
    { metric: "sp.purchase_order.status", subject: "PO-FAKE-99" },
    schema,
    "show the purchase order status",
    {},
  )).toEqual({ metric: "sp.purchase_order.status" });
  expect(groundEntityArguments(
    { metric: "sp.purchase_order.status", subject: "PO-2026-0042" },
    schema,
    "show status for PO-2026-0042",
    {},
  )).toEqual({ metric: "sp.purchase_order.status", subject: "PO-2026-0042" });
});

test("required collection filter slots may be cleared for server reconciliation", () => {
  const schema = {
    type: "object",
    properties: {
      filterValue: { type: "string" },
      filterValue2: { type: "string" },
      metric: { type: "string" },
    },
    required: ["filterValue", "filterValue2", "metric"],
  };
  expect(groundEntityArguments(
    { filterValue: "invented", filterValue2: "Acme Textiles", metric: "purchase order" },
    schema,
    "purchase orders from Acme Textiles",
    {},
  )).toEqual({ filterValue2: "Acme Textiles", metric: "purchase order" });
});

test("one malformed structured frame is retried once, then planning continues", async () => {
  const malformed = Object.assign(new Error("empty model frame"), { code: "OLLAMA_MALFORMED_RESPONSE" });
  const ask = jest.fn()
    .mockRejectedValueOnce(malformed)
    .mockResolvedValueOnce({ model: "qwen-test", data: { choice: "hr_holidays", clarification: null } });
  const result = await planToolQuestion({ question: "next company holiday", tools }, { chatJson: ask });
  expect(result).toMatchObject({ status: STATUS.OK, tool: "hr_holidays", arguments: {} });
  expect(ask).toHaveBeenCalledTimes(2);
});

test("semantic field options are ranked by the question and sent with human labels", () => {
  const prepared = prepareArgumentContract({
    type: "object",
    properties: {
      metric: {
        type: "string",
        enum: ["receipt.number", "putaway.from", "putaway.to"],
        "x-semanticOptions": {
          "receipt.number": { label: "receipt number", aliases: ["GRN number"] },
          "putaway.from": { label: "from location code", aliases: ["source location"] },
          "putaway.to": { label: "to location name", aliases: ["destination location"] },
        },
      },
    },
    required: ["metric"],
    additionalProperties: false,
  }, "which destination location was the receipt put away into?");
  expect(prepared.schema.properties.metric.enum[0]).toBe("putaway.to");
  expect(prepared.meanings.metric["putaway.to"].label).toBe("to location name");
  expect(prepared.schema.properties.metric["x-semanticOptions"]).toBeUndefined();
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

test("an elliptical follow-up contains user words and validated state, never assistant prose", () => {
  const context = recentContext([
    { role: "user", content: "who was absent yesterday" },
    {
      role: "assistant",
      content: "Asha was absent",
      toolsUsed: ["hr_daily_attendance"],
      contextState: { schema: "grav.assistant.plan/1", tool: "hr_daily_attendance", arguments: { date: "2026-09-25" } },
    },
  ], "what about today?");
  expect(context.previousUserMessages).toEqual(["who was absent yesterday"]);
  expect(context.previousPlan.tool).toBe("hr_daily_attendance");
  expect(JSON.stringify(context)).not.toContain("Asha was absent");
});

test("a complete new question clears previous subject, period and tool state", () => {
  const context = recentContext([
    { role: "user", content: "show Umung attendance for September 2026" },
    {
      role: "assistant",
      content: "18 days",
      contextState: {
        schema: "grav.assistant.plan/2",
        tool: "hr_attendance_records",
        arguments: { employeeName: "Umung", month: 9, year: 2026 },
      },
    },
  ], "what is Umung's salary?");
  expect(context).toEqual({ previousUserMessages: [], previousPlan: null });
});
