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
  // ── WHY 180s AND NOT 60s ──────────────────────────────────────────────
  // A source-backed Costing world now performs Industrial Engineering's REAL
  // confirmation through mounted routes — open the engineering file, register
  // each library operation, author the bulletin, open/fill/submit/approve a
  // method study per row as a second person, submit the version and approve it
  // as a third — plus payroll seeding that runs the salary model. That is ~15
  // HTTP round trips per world against an in-memory MongoDB, and suites build
  // several worlds each. At 60s a loaded machine failed roughly a dozen tests
  // on the clock rather than on a claim; nothing about what they assert
  // changed, only how long the setup they depend on legitimately takes.
  testTimeout: 180000,
  // The legacy root-level scripts are not jest tests.
  testPathIgnorePatterns: ["/node_modules/"],
};

