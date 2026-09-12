"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * The nightly Timer-SOP sweep is not safe on its own.
 *
 * Checked against the live store on 11 September 2026: the job had fired, had
 * beaten its heartbeat, and had judged **54 of 91 employees**. The other 37
 * carried no judgement at all — same day, same policy, nothing recorded — so
 * their scores showed zero while their colleagues had been deducted 0.7 points
 * each. The run had simply stopped part-way down the employee list.
 *
 * Two things make that worse than a late job:
 *
 *  1. The "already ran today" flag lives in memory, so a restart loses it, and
 *     outside the ten-minute 00:15 IST window the job will not fire again.
 *  2. A person with no watermark starts at YESTERDAY. So the day an interrupted
 *     run missed is not merely late — once the watermark moves past it, it is
 *     never judged at all. 9 September was lost for everybody that way.
 *
 * These pin the catch-up that makes the nightly run self-healing. The service
 * needs Firebase and Mongo to import, so its shape is read from source; the day
 * arithmetic it depends on is executed in timerSopTime.test.js.
 */

const ROOT = path.join(__dirname, "..");
const svc = fs.readFileSync(path.join(ROOT, "services", "timerSop.service.js"), "utf8");
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the service exposes a catch-up that finishes what an interrupted run missed", () => {
  assert.match(strip(svc), /async function evaluateTimerSopStragglers\(\)/);
  assert.match(strip(svc), /module\.exports = \{[^}]*evaluateTimerSopStragglers[^}]*\}/);
});

test("it selects only the employees whose watermark is behind, and never judges today", () => {
  const body = strip(svc).slice(strip(svc).indexOf("async function evaluateTimerSopStragglers"));
  /* Yesterday, not today: a day is judged only once it is over. */
  assert.match(body, /const yesterdayIST = addDaysToLabel\(todayIST, -1\)/);
  /* Three ways a watermark can be behind, and all three have to be caught —
     null, absent, and simply older. The 37 that were missed had null. */
  assert.match(body, /lastFinalizedDate: null/);
  assert.match(body, /lastFinalizedDate: \{ \$exists: false \}/);
  assert.match(body, /lastFinalizedDate: \{ \$lt: yesterdayIST \}/);
  assert.doesNotMatch(body, /\$lt: todayIST/, "judging today would close a day that is still running");
});

test("nobody behind costs one query and writes nothing", () => {
  const body = strip(svc).slice(strip(svc).indexOf("async function evaluateTimerSopStragglers"));
  assert.match(body, /if \(!behind\.length\) return \{ employeeCount: 0, totalBleaches: 0, results: \[\] \}/);
});

test("one employee's bad data cannot strand the rest, which is the fault being undone", () => {
  const body = strip(svc).slice(strip(svc).indexOf("async function evaluateTimerSopStragglers"));
  assert.match(body, /try \{[\s\S]*evaluateTimerSop\([\s\S]*\} catch \(e\) \{/);
  assert.match(body, /reason: "error"/);
});

test("the catch-up is registered, so its silence is alerted on like any other job", () => {
  assert.match(strip(server), /ensureJob\(\s*"timer-sop-catchup"/);
});

test("it runs shortly after boot and then on an interval, not only in the nightly window", () => {
  const s = strip(server);
  assert.match(s, /setTimeout\(runTimerSopCatchUp, 90 \* 1000\)/, "a restart is the likeliest reason somebody was left behind");
  assert.match(s, /setInterval\(runTimerSopCatchUp, 30 \* 60 \* 1000\)/);
});

test("turning the Timer SOP off turns the catch-up off with it", () => {
  const s = strip(server);
  const fn = s.slice(s.indexOf("const runTimerSopCatchUp"), s.indexOf("setTimeout(runTimerSopCatchUp"));
  assert.match(fn, /isEnabled\("timer-sop-finalize"\)/);
  assert.match(fn, /beat\("timer-sop-catchup"\)/);
  assert.match(fn, /beat\("timer-sop-catchup", \{ error: e\.message \}\)/);
});

test("the nightly job still owns the nightly window — the catch-up did not replace it", () => {
  const s = strip(server);
  assert.match(s, /const inWindow = hh === 0 && mm >= 15 && mm < 25/);
  assert.match(s, /evaluateTimerSopForAllEmployees/);
});
