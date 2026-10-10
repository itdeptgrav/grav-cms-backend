"use strict";

const { analyseSource } = require("../../services/ai/sourceInventory");

describe("assistant source inventory", () => {
  test("discovers literal and constant Firestore collections", () => {
    const result = analyseSource(`
      const TASKS = "cowork_tasks";
      db.collection(TASKS).doc(id).get();
      db.collection("cowork_employees").get();
    `, "routes/tasks.js");

    expect(result.firestoreCollections).toEqual(["cowork_employees", "cowork_tasks"]);
    expect(result.unresolvedCollections).toEqual([]);
  });

  test("does not silently accept dynamic collection names", () => {
    const result = analyseSource("db.collection(collectionFor(kind)).doc(id).get();", "routes/share.js");

    expect(result.firestoreCollections).toEqual([]);
    expect(result.unresolvedCollections).toEqual([
      { file: "routes/share.js", line: 1, expression: "collectionFor(kind)" },
    ]);
  });

  test("reports external data adapters separately", () => {
    const result = analyseSource(`
      const admin = require("firebase-admin");
      const { google } = require("googleapis");
      const local = require("../models/User");
    `);

    expect(result.externalModules).toEqual(["firebase-admin", "googleapis"]);
    expect(result.requires).toContain("../models/User");
  });
});
