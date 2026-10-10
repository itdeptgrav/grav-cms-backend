"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SERVICE, transcribeAnswer, trustedCompanyId } = require("./interviewSpeech.service");

const requestWith = (grants) => ({ hrAuth: { actor: { departmentRole: { companyGrants: grants } } } });

test("trustedCompanyId accepts exactly one active server-side company grant", async () => {
  assert.equal(await trustedCompanyId(requestWith([{ companyId: "company-a", isActive: true }])), "company-a");
  await assert.rejects(() => trustedCompanyId(requestWith([{ companyId: "a" }, { companyId: "b" }])), { code: "HR_COMPANY_CONTEXT_REQUIRED" });
});

test("legacy single-company HR derives the only active company on the server", async () => {
  const companyModel = { find: () => ({ select: () => ({ limit: () => ({ lean: async () => [{ _id: "company-only" }] }) }) }) };
  assert.equal(await trustedCompanyId(requestWith([]), { companyModel }), "company-only");
});

test("transcribeAnswer sends raw bytes through the central client and returns its raw result", async () => {
  const expected = {
    schemaVersion: "1",
    romanTranscript: "maine inventory count attend kiya",
    speakerTurns: [],
    manualOrLlmEditing: false,
  };
  let received;
  const result = await transcribeAnswer({
    req: requestWith([{ companyId: "company-a", isActive: true }]),
    file: { buffer: Buffer.from("audio"), originalname: "answer.webm" },
    client: async (input) => { received = input; return expected; },
  });
  assert.equal(received.service, SERVICE);
  assert.equal(received.companyId, "company-a");
  assert.equal(received.filename, "answer.webm");
  assert.deepEqual(received.audio, Buffer.from("audio"));
  assert.strictEqual(result, expected);
});
