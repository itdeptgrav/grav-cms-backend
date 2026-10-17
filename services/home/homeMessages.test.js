// node --test services/home/homeMessages.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { othersIn } = require("./homeMessages");

test("a thread is named for everyone in it but me", () => {
  const t = { participants: [
    { actorKey: "employee:me", name: "Me" },
    { actorKey: "employee:a", name: "Arpita Sen" },
    { actorKey: "employee:b", name: "Rohit" },
    { actorKey: "employee:c", name: "Kiran" },
    { actorKey: "employee:d", name: "Dev" },
  ] };
  assert.equal(othersIn(t, "employee:me"), "Arpita Sen, Rohit +2");
  assert.equal(othersIn({ participants: [{ actorKey: "employee:me", name: "Me" }, { actorKey: "employee:a", name: "Arpita Sen" }] }, "employee:me"), "Arpita Sen");
  assert.equal(othersIn({ participants: [] }, "employee:me"), "");
});
