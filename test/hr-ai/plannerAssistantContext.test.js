"use strict";

const mongoose = require("mongoose");
const PlannerGoal = require("../../models/Planner/PlannerGoal");
const PlannerTask = require("../../models/Planner/PlannerTask");
const { loadPlanner, summarizePlanner, resolvePlannerItem } = require("../../services/plannerAssistantContext");

describe("Planner assistant owner boundary", () => {
  test("one owner can never load, summarize or resolve another owner's planner rows", async () => {
    const ownerA = new mongoose.Types.ObjectId();
    const ownerB = new mongoose.Types.ObjectId();
    await PlannerGoal.create([
      { ownerId: ownerA, level: "vision", title: "Owner A Vision", status: "active" },
      { ownerId: ownerB, level: "vision", title: "Owner B Secret Vision", status: "active" },
    ]);
    await PlannerTask.create([
      { ownerId: ownerA, title: "Owner A Task", status: "todo" },
      { ownerId: ownerB, title: "Owner B Secret Task", status: "todo" },
    ]);

    const loaded = await loadPlanner({ id: String(ownerA) });
    expect(loaded.goals.map((row) => row.title)).toEqual(["Owner A Vision"]);
    expect(loaded.tasks.map((row) => row.title)).toEqual(["Owner A Task"]);
    expect(summarizePlanner(loaded, "overview")).toEqual(expect.objectContaining({
      goalCount: 1, taskCount: 1,
    }));
    expect(resolvePlannerItem(loaded, "status of Owner B Secret Task")).toEqual({
      found: false, ambiguous: false, matches: [],
    });
  });
});
