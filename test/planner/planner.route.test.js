// test/planner/planner.route.test.js
//
// HTTP-level tests for /api/planner. Follows test/crm/lead.route.test.js: the
// router on a bare Express app, driven with global fetch, with
// EmployeeAuthMiddlewear mocked so identity is assertable without a real JWT.
//
// THE SECTION THAT MATTERS MOST IS "another person's planner". Everything else
// here is CRUD; those tests are the ones standing between one employee's private
// goals and everyone else's, so they cover every handler that takes an id rather
// than a representative sample.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/EmployeeAuthMiddlewear", () => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Authentication required" });
  req.user = JSON.parse(raw);
  next();
});

const PlannerGoal = require("../../models/Planner/PlannerGoal");
const PlannerTask = require("../../models/Planner/PlannerTask");

const ME = { id: new mongoose.Types.ObjectId().toString(), employeeId: "GR0067", name: "Rishee" };
const SOMEONE_ELSE = { id: new mongoose.Types.ObjectId().toString(), employeeId: "GR0099", name: "Other" };

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/planner", require("../../routes/Planner/planner"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/planner`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path = "", { method = "GET", body, user = ME } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

const mkGoal = async (level, parentId, over = {}, user = ME) => {
  const { body } = await call("/goals", {
    method: "POST",
    user,
    body: { level, parentId, title: `${level} title`, ...over },
  });
  return body.data;
};

/** A full vision → mission → project spine, for the owner given. */
async function spine(user = ME) {
  const vision = await mkGoal("vision", null, {}, user);
  const mission = await mkGoal("mission", vision._id, {}, user);
  const project = await mkGoal("project", mission._id, {}, user);
  return { vision, mission, project };
}

/* ── auth ─────────────────────────────────────────────────────────────────── */

test("no session, no planner", async () => {
  const { status } = await call("/tree", { user: null });
  expect(status).toBe(401);
});

/* ── the ladder is enforced, not merely suggested ─────────────────────────── */

test("a vision is created at the top with no parent", async () => {
  const { status, body } = await call("/goals", {
    method: "POST",
    body: { level: "vision", title: "Run the factory I would want to work in" },
  });
  expect(status).toBe(201);
  expect(body.data.level).toBe("vision");
  expect(body.data.parentId).toBeNull();
});

test("a mission cannot float free of a vision", async () => {
  const { status, body } = await call("/goals", {
    method: "POST",
    body: { level: "mission", title: "Orphan" },
  });
  expect(status).toBe(400);
  expect(body.message).toMatch(/must belong to a vision/i);
});

test("a project cannot be hung straight off a vision — the rung is not skippable", async () => {
  const vision = await mkGoal("vision", null);
  const { status, body } = await call("/goals", {
    method: "POST",
    body: { level: "project", parentId: vision._id, title: "Skipped a rung" },
  });
  expect(status).toBe(400);
  expect(body.message).toMatch(/must belong to a mission, not a vision/i);
});

test("a vision handed a parent is refused rather than quietly rooted", async () => {
  const other = await mkGoal("vision", null);
  const { status } = await call("/goals", {
    method: "POST",
    body: { level: "vision", parentId: other._id, title: "Nested vision" },
  });
  expect(status).toBe(400);
});

test("an unknown level is refused", async () => {
  const { status } = await call("/goals", {
    method: "POST",
    body: { level: "epic", title: "Not a rung" },
  });
  expect(status).toBe(400);
});

/* ── the tree, with progress derived ──────────────────────────────────────── */

test("the tree comes back nested, with progress rolled up from the tasks", async () => {
  const { vision, mission, project } = await spine();
  await call("/tasks", { method: "POST", body: { goalId: project._id, title: "a", status: "done" } });
  await call("/tasks", { method: "POST", body: { goalId: project._id, title: "b" } });

  const { body } = await call("/tree");
  const v = body.data.visions[0];
  expect(v._id).toBe(vision._id);
  expect(v.children[0]._id).toBe(mission._id);
  expect(v.children[0].children[0].progress.percent).toBe(50);
  // …and the whole way up, with no stored number anywhere.
  expect(v.children[0].progress.percent).toBe(50);
  expect(v.progress.percent).toBe(50);
});

test("ticking a task moves every rung above it on the next read", async () => {
  const { project } = await spine();
  const { body: made } = await call("/tasks", {
    method: "POST",
    body: { goalId: project._id, title: "the only one" },
  });

  let { body } = await call("/tree");
  expect(body.data.visions[0].progress.percent).toBe(0);

  await call(`/tasks/${made.data._id}`, { method: "PATCH", body: { status: "done" } });

  ({ body } = await call("/tree"));
  expect(body.data.visions[0].progress.percent).toBe(100);
});

/* ── tasks: capture must stay free ────────────────────────────────────────── */

test("a task can be captured with no goal at all — it lands in the inbox", async () => {
  const { status } = await call("/tasks", { method: "POST", body: { title: "Occurred to me at 11pm" } });
  expect(status).toBe(201);

  const { body } = await call("/tree");
  expect(body.data.inbox).toHaveLength(1);
  expect(body.data.inbox[0].title).toBe("Occurred to me at 11pm");
});

test("an inbox task can be filed under a project later", async () => {
  const { project } = await spine();
  const { body: made } = await call("/tasks", { method: "POST", body: { title: "File me" } });

  await call(`/tasks/${made.data._id}`, { method: "PATCH", body: { goalId: project._id } });

  const { body } = await call("/tree");
  expect(body.data.inbox).toHaveLength(0);
  expect(body.data.visions[0].children[0].children[0].tasks).toHaveLength(1);
});

test("finishing a task stamps when, and un-finishing clears it", async () => {
  const { body: made } = await call("/tasks", { method: "POST", body: { title: "t" } });

  const { body: done } = await call(`/tasks/${made.data._id}`, {
    method: "PATCH",
    body: { status: "done" },
  });
  expect(done.data.doneAt).toBeTruthy();

  const { body: undone } = await call(`/tasks/${made.data._id}`, {
    method: "PATCH",
    body: { status: "todo" },
  });
  expect(undone.data.doneAt).toBeFalsy();
});

test("a due date is kept as the day that was picked, not shifted by a timezone", async () => {
  const { body } = await call("/tasks", {
    method: "POST",
    body: { title: "due", dueOn: "2026-09-15" },
  });
  expect(new Date(body.data.dueOn).toISOString()).toBe("2026-09-15T00:00:00.000Z");
});

test("today's list carries overdue work forward instead of leaving it behind", async () => {
  await call("/tasks", { method: "POST", body: { title: "overdue", dueOn: "2020-01-01" } });
  await call("/tasks", { method: "POST", body: { title: "far off", dueOn: "2099-01-01" } });

  const { body } = await call("/tasks?scope=today");
  expect(body.data.map((t) => t.title)).toEqual(["overdue"]);
});

/* ── delete is narrow ─────────────────────────────────────────────────────── */

test("a goal that still holds something cannot be deleted, and says what is in it", async () => {
  const { vision } = await spine();
  const { status, body } = await call(`/goals/${vision._id}`, { method: "DELETE" });
  expect(status).toBe(409);
  expect(body.message).toMatch(/drop this instead/i);
});

test("deleting a project unfiles its tasks rather than destroying them", async () => {
  const { project } = await spine();
  await call("/tasks", { method: "POST", body: { goalId: project._id, title: "survivor" } });

  const { status, body } = await call(`/goals/${project._id}`, { method: "DELETE" });
  expect(status).toBe(200);
  expect(body.data.tasksUnfiled).toBe(1);

  const { body: tree } = await call("/tree");
  expect(tree.data.inbox.map((t) => t.title)).toEqual(["survivor"]);
});

test("dropping a goal keeps it and its reason", async () => {
  const vision = await mkGoal("vision", null);
  const { body } = await call(`/goals/${vision._id}`, {
    method: "PATCH",
    body: { status: "dropped", statusNote: "Wrong thing to be aiming at." },
  });
  expect(body.data.status).toBe("dropped");
  expect(body.data.statusNote).toBe("Wrong thing to be aiming at.");
  expect(body.data.statusAt).toBeTruthy();
});

/* ── another person's planner ─────────────────────────────────────────────── */

test("the tree shows only my own goals", async () => {
  await spine(ME);
  await spine(SOMEONE_ELSE);

  const { body } = await call("/tree", { user: ME });
  expect(body.data.visions).toHaveLength(1);
  expect(await PlannerGoal.countDocuments({})).toBe(6);
});

test("I cannot read, edit or delete someone else's goal", async () => {
  const theirs = await mkGoal("vision", null, {}, SOMEONE_ELSE);

  const patched = await call(`/goals/${theirs._id}`, {
    method: "PATCH",
    user: ME,
    body: { title: "Hijacked" },
  });
  expect(patched.status).toBe(404);

  const deleted = await call(`/goals/${theirs._id}`, { method: "DELETE", user: ME });
  expect(deleted.status).toBe(404);

  const still = await PlannerGoal.findById(theirs._id).lean();
  expect(still.title).toBe("vision title");
});

test("I cannot hang my mission off someone else's vision", async () => {
  const theirVision = await mkGoal("vision", null, {}, SOMEONE_ELSE);
  const { status, body } = await call("/goals", {
    method: "POST",
    user: ME,
    body: { level: "mission", parentId: theirVision._id, title: "Trespass" },
  });
  expect(status).toBe(400);
  expect(body.message).toMatch(/does not exist in your planner/i);
});

test("I cannot reparent my mission onto someone else's vision either", async () => {
  const { mission } = await spine(ME);
  const theirVision = await mkGoal("vision", null, {}, SOMEONE_ELSE);

  const { status } = await call(`/goals/${mission._id}`, {
    method: "PATCH",
    user: ME,
    body: { parentId: theirVision._id },
  });
  expect(status).toBe(400);
});

test("I cannot file my task against someone else's goal", async () => {
  const theirs = await mkGoal("vision", null, {}, SOMEONE_ELSE);
  const { status } = await call("/tasks", {
    method: "POST",
    user: ME,
    body: { title: "Trespass", goalId: theirs._id },
  });
  expect(status).toBe(400);
});

test("I cannot touch someone else's task", async () => {
  const { body: theirs } = await call("/tasks", {
    method: "POST",
    user: SOMEONE_ELSE,
    body: { title: "Private" },
  });

  expect((await call(`/tasks/${theirs.data._id}`, { method: "PATCH", user: ME, body: { title: "x" } })).status).toBe(404);
  expect((await call(`/tasks/${theirs.data._id}`, { method: "DELETE", user: ME })).status).toBe(404);
  expect(await PlannerTask.countDocuments({})).toBe(1);
});

test("ownerId is taken from the session, never from the body", async () => {
  const { body } = await call("/goals", {
    method: "POST",
    user: ME,
    body: { level: "vision", title: "Mine", ownerId: SOMEONE_ELSE.id },
  });
  const saved = await PlannerGoal.findById(body.data._id).lean();
  expect(String(saved.ownerId)).toBe(ME.id);
});

/* ── review ───────────────────────────────────────────────────────────────── */

test("review surfaces an empty project, with the ladder above it", async () => {
  await spine();
  const { status, body } = await call("/review");
  expect(status).toBe(200);

  const item = body.data.items.find((i) => i.level === "project");
  expect(item.reason).toBe("empty");
  expect(item.path).toEqual(["vision title", "mission title"]);
  expect(body.data.needsDecision).toBeGreaterThan(0);
});

test("review counts unfiled tasks without listing them as faults", async () => {
  await spine();
  await call("/tasks", { method: "POST", body: { title: "unfiled" } });

  const { body } = await call("/review");
  expect(body.data.unfiled).toBe(1);
});

test("review is mine alone", async () => {
  await spine(SOMEONE_ELSE);
  const { body } = await call("/review", { user: ME });
  expect(body.data.items).toHaveLength(0);
});

test("a healthy ladder asks for nothing", async () => {
  const { project } = await spine();
  await call("/tasks", { method: "POST", body: { goalId: project._id, title: "live work" } });

  const { body } = await call("/review");
  expect(body.data.needsDecision).toBe(0);
});
