"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyConfirmation, classifyIntent } = require("./mrfVoiceIntent.service");

test("approval intents cover English, Hindi and Odia", () => {
  assert.equal(classifyIntent("Approve this request").intent, "APPROVE");
  assert.equal(classifyIntent("यह अनुरोध मंजूर है").intent, "APPROVE");
  assert.equal(classifyIntent("ଏହି ଅନୁରୋଧ ଅନୁମୋଦନ କରନ୍ତୁ").intent, "APPROVE");
});

test("later wins over an approval word", () => {
  assert.equal(classifyIntent("I will approve later").intent, "DEFER");
  assert.equal(classifyIntent("बाद में मंजूर करूंगा").intent, "DEFER");
  assert.equal(classifyIntent("ପରେ ଅନୁମୋଦନ କରିବି").intent, "DEFER");
});

test("natural decision sentences do not require command words", () => {
  assert.equal(classifyIntent("Everything looks fine to me, you can proceed").intent, "APPROVE");
  assert.equal(classifyIntent("Please send this back, the quantity is wrong").intent, "REJECT");
  assert.equal(classifyIntent("I need some time, leave this pending").intent, "DEFER");
});

test("reject, repeat and open request remain separate", () => {
  assert.equal(classifyIntent("Reject it").intent, "REJECT");
  assert.equal(classifyIntent("दोबारा पढ़िए").intent, "REPEAT");
  assert.equal(classifyIntent("Show me the MRF details").intent, "OPEN_REQUEST");
});

test("confirmation is a separate turn", () => {
  assert.equal(classifyConfirmation("हाँ").intent, "CONFIRM");
  assert.equal(classifyConfirmation("ହଁ").intent, "CONFIRM");
  assert.equal(classifyConfirmation("cancel").intent, "CANCEL");
  assert.equal(classifyConfirmation("approve").intent, "UNKNOWN");
  assert.equal(classifyConfirmation("Yes, that is right, please proceed with it").intent, "CONFIRM");
  assert.equal(classifyConfirmation("Actually no, I changed my mind").intent, "CANCEL");
});

test("romanized Hindi and Odia from GRAV Speech stay deterministic", () => {
  assert.equal(classifyIntent("baad mein approve karunga").intent, "DEFER");
  assert.equal(classifyIntent("manjoor").intent, "APPROVE");
  assert.equal(classifyIntent("pratyakhyana").intent, "REJECT");
  assert.equal(classifyConfirmation("haan").intent, "CONFIRM");
  assert.equal(classifyConfirmation("batil").intent, "CANCEL");
});
