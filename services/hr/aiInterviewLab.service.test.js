"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { chatJson } = require("../ollamaClient");
const { assessTurn, createOpening, generateInterviewReport, normaliseRubric, translateQuestion } = require("./aiInterviewLab.service");
const indicSpeakTts = require("./indicSpeakTts.service");

function pcmWav(sampleCount = 2400) {
  const pcm = Buffer.alloc(sampleCount * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

test("normaliseRubric owns criterion ids and constrains points", () => {
  const result = normaliseRubric([
    { id: "candidate-controlled", label: " Technical reasoning ", description: "Apply the standard", maxPoints: 999 },
    { label: "Evidence", maxPoints: -5 },
  ]);
  assert.deepEqual(result, [
    { id: "criterion-1", label: "Technical reasoning", description: "Apply the standard", maxPoints: 10 },
    { id: "criterion-2", label: "Evidence", description: "", maxPoints: 1 },
  ]);
});

test("chatJson forwards opt-in thinking while returning only the final JSON content", async () => {
  let sent;
  const fetchImpl = async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ message: { thinking: "private reasoning", content: '{"ok":true}' } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await chatJson({ system: "system", prompt: "prompt", think: true, fetchImpl, baseUrl: "http://example.test", model: "qwen3:32b" });
  assert.equal(sent.think, true);
  assert.deepEqual(result.data, { ok: true });
});

test("Indic-Speak reports whether its server-side key is configured", () => {
  const previousKey = process.env.BODHAN_API_KEY;
  delete process.env.BODHAN_API_KEY;
  const unavailable = indicSpeakTts.health();
  assert.equal(unavailable.configured, false);
  assert.equal(unavailable.provider, "indic-speak");
  process.env.BODHAN_API_KEY = "bodhan_test_key";
  const configured = indicSpeakTts.health();
  assert.equal(configured.configured, true);
  assert.equal(configured.defaultVoice, "Kavya");
  assert.equal(configured.defaultVoices.od, "Itishree");
  assert.deepEqual(configured.voices, indicSpeakTts.VOICE_OPTIONS);
  if (previousKey === undefined) delete process.env.BODHAN_API_KEY;
  else process.env.BODHAN_API_KEY = previousKey;
});

test("Indic-Speak requests WAV audio without exposing model control to the browser", async () => {
  const previous = {
    key: process.env.BODHAN_API_KEY,
    model: process.env.BODHAN_TTS_MODEL,
    voice: process.env.BODHAN_TTS_VOICE,
  };
  process.env.BODHAN_API_KEY = "bodhan_test_key";
  process.env.BODHAN_TTS_MODEL = "indic-speak";
  process.env.BODHAN_TTS_VOICE = "Kavya";
  let request;
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0, "ascii");
  const result = await indicSpeakTts.synthesize("Unique English interview question", {
    fetchImpl: async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return new Response(wav, {
        status: 200,
        headers: { "content-type": "audio/wav", "x-request-id": "request-1" },
      });
    },
  });
  assert.equal(request.url, "https://api.bodhan.ai/v1/audio/speech");
  assert.equal(request.headers.Authorization, "Bearer bodhan_test_key");
  assert.deepEqual(request.body, {
    model: "indic-speak",
    input: "Unique English interview question",
    voice: "Kavya",
    instructions: JSON.stringify({ lang: "en" }),
  });
  assert.equal(result.contentType, "audio/wav");
  assert.deepEqual(result.bytes, wav);
  for (const [name, value] of [
    ["BODHAN_API_KEY", previous.key],
    ["BODHAN_TTS_MODEL", previous.model],
    ["BODHAN_TTS_VOICE", previous.voice],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("Indic-Speak accepts only approved voices and maps Odia to provider code or", async () => {
  const previousKey = process.env.BODHAN_API_KEY;
  process.env.BODHAN_API_KEY = "bodhan_test_key";
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0, "ascii");
  let sent;
  await indicSpeakTts.synthesize("Inventory ଠିକ୍ ଅଛି କି ନାହିଁ କିପରି check କରିବେ?", {
    voice: "Itishree",
    language: "od",
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } });
    },
  });
  assert.equal(sent.voice, "Itishree");
  assert.equal(sent.instructions, JSON.stringify({ lang: "or" }));
  await assert.rejects(
    indicSpeakTts.synthesize("Welcome", { voice: "browser-controlled-voice" }),
    (error) => error.code === "INVALID_INPUT"
  );
  await assert.rejects(
    indicSpeakTts.synthesize("Welcome", { voice: "Kavya", language: "od" }),
    (error) => error.code === "INVALID_INPUT"
  );
  if (previousKey === undefined) delete process.env.BODHAN_API_KEY;
  else process.env.BODHAN_API_KEY = previousKey;
});

test("delivery cues become provider styles and real PCM pauses", async () => {
  const previousKey = process.env.BODHAN_API_KEY;
  process.env.BODHAN_API_KEY = "bodhan_test_key";
  assert.deepEqual(indicSpeakTts.parseDeliveryScript("[warm] Welcome. [pause] Please introduce yourself."), [
    { type: "speech", text: "Welcome.", style: "Customer Care" },
    { type: "pause", durationMs: 450 },
    { type: "speech", text: "Please introduce yourself.", style: "Customer Care" },
  ]);
  const requests = [];
  const upstreamWav = pcmWav();
  const result = await indicSpeakTts.synthesize("[warm] Unique welcome. [pause] Please introduce yourself.", {
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(upstreamWav, { status: 200, headers: { "content-type": "audio/wav" } });
    },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[0].instructions), { lang: "en", style: "Customer Care" });
  assert.deepEqual(JSON.parse(requests[1].instructions), { lang: "en", style: "Customer Care" });
  assert.equal(result.bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(result.bytes.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(result.bytes.readUInt32LE(40), (2400 * 2 * 2) + Math.round(48000 * 0.45));
  if (previousKey === undefined) delete process.env.BODHAN_API_KEY;
  else process.env.BODHAN_API_KEY = previousKey;
});

test("Hindi question speech translates through the configured Qwen API without changing the source", async () => {
  let sent;
  const result = await translateQuestion("How would you verify inventory existence?", "hi", {
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ translatedText: "Aap kaise check karenge ki inventory actually present hai?" }) } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(sent.model, process.env.INTERVIEW_OLLAMA_MODEL || "qwen3:32b");
  assert.match(sent.messages[0].content, /conversational Indian Hinglish/);
  assert.match(sent.messages[0].content, /avoid formal, literary, Sanskrit-heavy/);
  assert.equal(result.sourceText, "How would you verify inventory existence?");
  assert.match(sent.messages[1].content, /\"script\":\"Roman\"/);
  assert.equal(result.spokenText, "Aap kaise check karenge ki inventory actually present hai?");
  assert.equal(result.language, "hi");
  assert.equal(result.translated, true);
});

test("Odia question speech uses conversational native-script instructions", async () => {
  let sent;
  const result = await translateQuestion("How would you verify inventory valuation?", "od", {
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ translatedText: "Inventory valuation ଠିକ୍ ଅଛି କି ନାହିଁ ଆପଣ କିପରି check କରିବେ?" }) } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.match(sent.messages[0].content, /conversational modern Odia/);
  assert.match(sent.messages[0].content, /native Odia script/);
  assert.match(sent.messages[1].content, /"targetLanguage":"Conversational Odia"/);
  assert.match(sent.messages[1].content, /"script":"Odia"/);
  assert.equal(result.sourceText, "How would you verify inventory valuation?");
  assert.equal(result.language, "od");
  assert.equal(result.translated, true);
});

test("English question speech bypasses translation", async () => {
  let called = false;
  const result = await translateQuestion("Please introduce yourself.", "en", {
    fetchImpl: async () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(result.spokenText, "Please introduce yourself.");
  assert.equal(result.translated, false);
});

test("Qwen creates a warm opening that asks the supplied introduction question", async () => {
  let sent;
  const result = await createOpening({
    role: "Chartered Accountant",
    introductionQuestion: "Could you briefly introduce yourself and tell me about your relevant experience?",
  }, {
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ message: { content: JSON.stringify({
        interviewerText: "[warm] Welcome, and thank you for joining us today. [pause] Could you briefly introduce yourself and tell me about your relevant experience?",
      }) } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.match(sent.messages[0].content, /exactly one \[pause\]/);
  assert.match(sent.messages[1].content, /Chartered Accountant/);
  assert.match(result.interviewerText, /^\[warm\]/);
  assert.match(result.interviewerText, /\[pause\]/);
});

const TURN_RUBRIC = [{ label: "Technical reasoning", description: "Explains the procedure", maxPoints: 3 }];

test("a request to repeat is replayed and never scored as an answer", async () => {
  let modelCalled = false;
  const result = await assessTurn({
    role: "Chartered Accountant",
    question: "How would you test inventory existence?",
    answer: "Sorry, could you repeat the question?",
    rubric: TURN_RUBRIC,
  }, {
    fetchImpl: async () => { modelCalled = true; throw new Error("repeat requests must not call Qwen"); },
  });
  assert.equal(result.nextAction, "repeat_question");
  assert.equal(result.interviewerText, "How would you test inventory existence?");
  assert.equal(result.evaluation, null);
  assert.equal(result.model, null);
  assert.equal(modelCalled, false);
});

test("common Hinglish repeat requests are recognised without model latency", async () => {
  for (const answer of ["Ek baar phir boliye", "Please dobara boliye", "Could you say that again?"]) {
    const result = await assessTurn({ role: "CA", question: "Explain audit evidence.", answer, rubric: TURN_RUBRIC }, {
      fetchImpl: async () => { throw new Error("Qwen should not be called"); },
    });
    assert.equal(result.nextAction, "repeat_question");
  }
});

test("Qwen may ask one evidence-focused follow-up but the server enforces the cap", async () => {
  const response = {
    intent: "answer",
    acknowledgement: "[warm] Thank you, you have outlined an inspection step. [pause]",
    criteria: [{ id: "criterion-1", score: 1, evidence: "I would inspect it", reason: "Procedure lacks detail" }],
    contradictions: [],
    summary: "Partial procedure.",
    needsFollowUp: true,
    followUp: "Which audit evidence would you retain?",
    followUpReason: "Evidence was not identified.",
  };
  const fetchImpl = async () => new Response(JSON.stringify({ message: { content: JSON.stringify(response) } }), { status: 200, headers: { "content-type": "application/json" } });
  const first = await assessTurn({ role: "CA", question: "Explain the audit.", answer: "I would inspect it.", rubric: TURN_RUBRIC, followUpCount: 0 }, { fetchImpl });
  assert.equal(first.nextAction, "ask_follow_up");
  assert.equal(first.followUpCount, 1);
  assert.match(first.acknowledgement, /inspection step/);
  const capped = await assessTurn({ role: "CA", question: "Explain the audit.", answer: "I would inspect it.", rubric: TURN_RUBRIC, followUpCount: 2 }, { fetchImpl });
  assert.equal(capped.nextAction, "next_question");
  assert.equal(capped.interviewerText, "");
});

test("the introduction is acknowledged but never scored or followed up", async () => {
  const response = {
    intent: "answer",
    acknowledgement: "[warm] Thank you for that introduction. [pause]",
    criteria: [],
    contradictions: [],
    summary: "",
    needsFollowUp: false,
    followUp: "",
    followUpReason: "",
  };
  const result = await assessTurn({
    role: "CA",
    question: "Please introduce yourself.",
    answer: "I have five years of audit experience.",
    rubric: TURN_RUBRIC,
    conversationOnly: true,
    nextQuestion: "How would you test inventory existence?",
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ message: { content: JSON.stringify(response) } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(result.nextAction, "next_question");
  assert.equal(result.evaluation, null);
  assert.match(result.acknowledgement, /introduction/);
  assert.equal(result.interviewerText, "");
});

test("the final report recomputes bounded evidence scores and never makes a hiring recommendation", async () => {
  const result = await generateInterviewReport({
    role: "CA",
    rubric: TURN_RUBRIC,
    turns: [{ question: "How would you test inventory?", answer: "I would attend the count and test count sheets." }],
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ message: { content: JSON.stringify({
      questions: [{ questionNumber: 1, criteria: [{ id: "criterion-1", score: 2, evidence: "attend the count", reason: "Relevant procedure" }], summary: "Relevant but incomplete." }],
      overallSummary: "The answer identifies an appropriate procedure.",
      strengths: ["Physical count attendance"],
      gaps: ["Valuation evidence"],
      contradictions: [],
      recommendedHumanQuestions: ["How would you test valuation?"],
    }) } }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(result.score, 2);
  assert.equal(result.maxScore, 3);
  assert.equal(result.recommendation, null);
  assert.equal(result.humanReviewRequired, true);
});
