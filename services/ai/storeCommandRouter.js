"use strict";
/**
 * services/ai/storeCommandRouter.js — qwen3:8b as the palette's router, and
 * nothing else.
 *
 * The ONLY file on the palette's side that talks to a model, and it is loaded
 * only by the HTTP route, only when `STORE_COMMAND_ROUTER` is set. The search
 * service never requires it: the router is handed in, so the deterministic
 * path stays model-free by construction, and with the variable unset the
 * palette is exactly what it was.
 *
 * The model is shown the sentence and a menu of names
 * (`storeCommandRouterContract.promptFor`) and must answer with a closed
 * object (`schemaFor`). What it says is validated again by the contract and
 * then answered by the deterministic layer. It never sees a record and never
 * writes a word the person reads.
 *
 *   STORE_COMMAND_ROUTER             "qwen" to turn it on; unset or "off" leaves it off
 *   STORE_COMMAND_ROUTER_URL         default http://127.0.0.1:11434 (local Ollama)
 *   STORE_COMMAND_ROUTER_MODEL       default qwen3:8b
 *   STORE_COMMAND_ROUTER_TIMEOUT_MS  default 5000 — warm qwen3:8b measured 2–4.3 s on an M4; a router slower than this
 *                                    is a router the person does not wait for
 *
 * Its own settings, deliberately not `OLLAMA_*`: those point the assistant at
 * qwen3:32b over a tunnel, and the router must not inherit a rented GPU by
 * accident.
 */

const { chatJson } = require("../ollamaClient");
const { SYSTEM, schemaFor, promptFor } = require("./storeCommandRouterContract");

const DEFAULTS = Object.freeze({
  url: "http://127.0.0.1:11434",
  model: "qwen3:8b",
  timeoutMs: 5000,
});

/** The configured router, or null when it is off. */
function routerFromEnv(env = process.env, { chat = chatJson } = {}) {
  const mode = String(env.STORE_COMMAND_ROUTER || "").trim().toLowerCase();
  if (!mode || mode === "off" || mode === "0" || mode === "false") return null;
  const baseUrl = env.STORE_COMMAND_ROUTER_URL || DEFAULTS.url;
  const model = env.STORE_COMMAND_ROUTER_MODEL || DEFAULTS.model;
  const timeoutMs = Number(env.STORE_COMMAND_ROUTER_TIMEOUT_MS) || DEFAULTS.timeoutMs;

  const route = async ({ message, menu }) => {
    const { data } = await chat({
      system: SYSTEM,
      prompt: promptFor(menu, message),
      schema: schemaFor(menu),
      temperature: 0,
      numPredict: 160,
      timeoutMs,
      baseUrl,
      model,
      keepAlive: "30m",
    });
    return data;
  };
  route.model = model;
  return route;
}

module.exports = { routerFromEnv, DEFAULTS };
