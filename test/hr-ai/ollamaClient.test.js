"use strict";
/**
 * Unit tests for services/ollamaClient — the local Ollama wrapper.
 *
 * No Ollama server and no network: every case injects a fake `fetchImpl`, so
 * these run fully offline. Covers the happy path plus each predictable failure
 * the route relies on being classified (timeout, model-not-found, unavailable,
 * bad status, malformed) and the <think>-stripping guarantee.
 */

const { chatJson, OllamaError, OLLAMA_ERROR_CODES } = require("../../services/ollamaClient");

function okJson(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: "qwen3:8b", message: { role: "assistant", content } }),
  };
}

describe("ollamaClient.chatJson", () => {
  test("returns parsed JSON on a clean response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      okJson('{"summary":"All good","priorities":["x"]}'),
    );
    const { data, model } = await chatJson({ system: "s", prompt: "p", fetchImpl });
    expect(model).toBe("qwen3:8b");
    expect(data.summary).toBe("All good");
    expect(data.priorities).toEqual(["x"]);
  });

  test("strips a <think> reasoning block before parsing", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(okJson('<think>let me reason...</think>{"summary":"clean"}'));
    const { data } = await chatJson({ prompt: "p", fetchImpl });
    expect(data.summary).toBe("clean");
  });

  test("extracts the JSON object when surrounded by prose", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(okJson('Sure! Here you go: {"summary":"ok"} — hope that helps'));
    const { data } = await chatJson({ prompt: "p", fetchImpl });
    expect(data.summary).toBe("ok");
  });

  test("classifies a missing model as MODEL_NOT_FOUND", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'model "qwen3:8b" not found, try pulling it first',
    });
    await expect(chatJson({ prompt: "p", fetchImpl })).rejects.toMatchObject({
      code: OLLAMA_ERROR_CODES.MODEL_NOT_FOUND,
    });
  });

  test("classifies a non-2xx as BAD_STATUS", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal error",
    });
    await expect(chatJson({ prompt: "p", fetchImpl })).rejects.toMatchObject({
      code: OLLAMA_ERROR_CODES.BAD_STATUS,
    });
  });

  test("classifies a connection error as UNAVAILABLE", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:11434"));
    await expect(chatJson({ prompt: "p", fetchImpl })).rejects.toMatchObject({
      code: OLLAMA_ERROR_CODES.UNAVAILABLE,
    });
  });

  test("classifies an aborted request as TIMEOUT", async () => {
    const fetchImpl = jest.fn().mockImplementation(() => {
      const e = new Error("aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    });
    await expect(chatJson({ prompt: "p", fetchImpl, timeoutMs: 50 })).rejects.toMatchObject({
      code: OLLAMA_ERROR_CODES.TIMEOUT,
    });
  });

  test("classifies non-JSON model output as MALFORMED", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okJson("I cannot answer that."));
    await expect(chatJson({ prompt: "p", fetchImpl })).rejects.toMatchObject({
      code: OLLAMA_ERROR_CODES.MALFORMED,
    });
  });

  test("classifies a non-JSON envelope as MALFORMED", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token");
      },
    });
    await expect(chatJson({ prompt: "p", fetchImpl })).rejects.toBeInstanceOf(OllamaError);
  });

  test("respects OLLAMA_BASE_URL / OLLAMA_MODEL overrides", async () => {
    const prev = { url: process.env.OLLAMA_BASE_URL, model: process.env.OLLAMA_MODEL };
    process.env.OLLAMA_BASE_URL = "http://example.test:9999";
    process.env.OLLAMA_MODEL = "custom:1b";
    const fetchImpl = jest.fn().mockResolvedValue(okJson('{"summary":"x"}'));
    const { model } = await chatJson({ prompt: "p", fetchImpl });
    expect(model).toBe("custom:1b");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://example.test:9999/api/chat",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("custom:1b");
    expect(body.stream).toBe(false);
    expect(body.format).toBe("json");
    expect(body.think).toBe(false);
    process.env.OLLAMA_BASE_URL = prev.url;
    process.env.OLLAMA_MODEL = prev.model;
  });
});
