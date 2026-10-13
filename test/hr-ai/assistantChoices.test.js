"use strict";

const {
  sanitizeAssistantChoice,
  sanitizeAssistantChoices,
} = require("../../services/ai/assistantChoices");
const convo = require("../../services/ai/conversationStore");

describe("assistant prompt choices", () => {
  beforeEach(() => convo._clearAll());

  test("accepts bounded text choices and never accepts navigation metadata", () => {
    expect(sanitizeAssistantChoice({
      label: "Apple MacBook Air",
      prompt: "stock of Apple MacBook Air",
      href: "https://evil.example",
    })).toEqual({
      label: "Apple MacBook Air",
      prompt: "stock of Apple MacBook Air",
      kind: "prompt",
    });
    expect(sanitizeAssistantChoice({ label: "Missing prompt" })).toBeNull();
  });

  test("deduplicates and persists choices with assistant history", () => {
    const choice = { label: "MacBook", prompt: "stock of Apple MacBook Air" };
    const choices = sanitizeAssistantChoices([choice, choice]);
    expect(choices).toHaveLength(1);
    convo.append("employee-1", { role: "assistant", content: "Choose an item.", choices });
    expect(convo.getHistory("employee-1")[0].choices).toEqual(choices);
  });
});
