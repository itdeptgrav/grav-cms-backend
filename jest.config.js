// jest.config.js
//
// Backend test runner for the CRM foundation. Tests run against an in-memory
// MongoDB (mongodb-memory-server) — they never touch the live dev database.
// Scoped to test/ so the repo's legacy interactive *_test.js scripts at the
// root (which DO mutate the live DB) are not picked up.
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  setupFilesAfterEnv: ["<rootDir>/test/setup.js"],
  testTimeout: 60000,
  // The legacy root-level scripts are not jest tests.
  testPathIgnorePatterns: ["/node_modules/"],
};
