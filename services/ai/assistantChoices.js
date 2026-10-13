"use strict";

const MAX_CHOICES = 8;
const MAX_LABEL_LENGTH = 160;
const MAX_PROMPT_LENGTH = 500;

function sanitizeAssistantChoice(choice) {
  if (!choice || typeof choice !== "object") return null;
  const label = typeof choice.label === "string" ? choice.label.trim() : "";
  const prompt = typeof choice.prompt === "string" ? choice.prompt.trim() : "";
  if (!label || !prompt) return null;
  if (label.length > MAX_LABEL_LENGTH || prompt.length > MAX_PROMPT_LENGTH) return null;
  return { label, prompt, kind: "prompt" };
}

function sanitizeAssistantChoices(choices) {
  const safe = [];
  const seen = new Set();
  for (const choice of Array.isArray(choices) ? choices : []) {
    const item = sanitizeAssistantChoice(choice);
    if (!item) continue;
    const key = `${item.label}\u0000${item.prompt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    safe.push(item);
    if (safe.length >= MAX_CHOICES) break;
  }
  return safe;
}

module.exports = {
  MAX_CHOICES,
  sanitizeAssistantChoice,
  sanitizeAssistantChoices,
};
