"use strict";

jest.mock("../../services/plannerAssistantContext", () => ({
  loadPlanner: jest.fn(),
  summarizePlanner: jest.fn(),
  resolvePlannerItem: jest.fn(),
}));

const registry = require("../../services/ai/toolRegistry");
const context = require("../../services/plannerAssistantContext");

describe("Personal Planner semantic and privacy contract", () => {
  beforeAll(() => {
    registry._clear();
    require("../../services/ai/tools/plannerTools");
  });

  beforeEach(() => jest.clearAllMocks());

  test("summary requests are catalogue-owned and never model-selected", async () => {
    const tool = registry.getTool("planner_metric");
    expect(tool.modelSelectable).toBe(false);
    await expect(tool.claim({ user: { id: "owner" }, message: "what tasks are due today?" }))
      .resolves.toEqual({ metric: "planner.due_today_tasks" });
    expect(context.loadPlanner).not.toHaveBeenCalled();
  });

  test("an item field is claimed only after an exact owner-scoped title resolves", async () => {
    const tool = registry.getTool("planner_metric");
    context.loadPlanner.mockResolvedValue({});
    context.resolvePlannerItem.mockReturnValueOnce({ found: true, record: { title: "Launch site" } });
    await expect(tool.claim({ user: { id: "owner" }, message: "status of Launch site project" }))
      .resolves.toEqual({ metric: "planner.item_status" });
    context.resolvePlannerItem.mockReturnValueOnce({ found: false, ambiguous: false, matches: [] });
    await expect(tool.claim({ user: { id: "owner" }, message: "status of Unknown project" }))
      .resolves.toBeNull();
  });

  test("the deterministic renderer returns only the requested planner field", async () => {
    const tool = registry.getTool("planner_metric");
    context.loadPlanner.mockResolvedValue({});
    context.resolvePlannerItem.mockReturnValue({
      found: true,
      record: { kind: "task", title: "Pay supplier", status: "doing", notes: "private note", dueOn: "2026-10-03" },
    });
    const args = { metric: "planner.item_status" };
    const data = await tool.provideContext({ user: { id: "owner" }, message: "Pay supplier task status", args });
    const answer = tool.renderAnswer({ data, args });
    expect(answer).toBe("Pay supplier's planner item status is doing.");
    expect(answer).not.toContain("private note");
    expect(answer).not.toContain("2026-10-03");
  });

  test("ambiguous task and goal titles require disambiguation", async () => {
    const tool = registry.getTool("planner_metric");
    context.loadPlanner.mockResolvedValue({});
    context.resolvePlannerItem.mockReturnValue({
      found: false,
      ambiguous: true,
      matches: [{ title: "Launch", kind: "task" }, { title: "Launch", kind: "goal" }],
    });
    const data = await tool.provideContext({
      user: { id: "owner" }, message: "Launch status", args: { metric: "planner.item_status" },
    });
    expect(tool.renderAnswer({ data })).toMatch(/more than one planner item.*Launch \(task\).*Launch \(goal\)/i);
  });

  test("only an authenticated owner may read a personal planner", () => {
    const tool = registry.getTool("planner_metric");
    expect(tool.permission({ id: "owner" })).toBe(true);
    expect(tool.permission({})).toBe(false);
  });
});
