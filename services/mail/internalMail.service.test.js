"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { purposeClause } = require("./internalMail.service");

test("Chat can query only explicitly tagged Chat threads", () => {
  assert.deepEqual(purposeClause("chat"), { purpose: "chat" });
});

test("Mail owns legacy untagged rows but never Chat rows", () => {
  assert.deepEqual(purposeClause("mail"), {
    $or: [{ purpose: "mail" }, { purpose: { $exists: false } }],
  });
});
