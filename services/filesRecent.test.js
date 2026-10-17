// Sheets' Recent and Save, through the real Files routes (routes/Access/files.js)
// on an in-memory MongoDB. Google Drive is replaced by a stand-in that keeps
// bytes in a Map, so nothing leaves the machine.
//
//   node --test services/filesRecent.test.js
//
// The first run downloads a MongoDB binary for mongodb-memory-server.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

/* Drive, in memory — installed before the router loads it. */
const driveStore = new Map();
let driveSeq = 0;
const drivePath = path.join(__dirname, "companyDrive.service.js");
require.cache[drivePath] = {
  id: drivePath,
  filename: drivePath,
  loaded: true,
  exports: {
    uploadCompanyFile: async (buffer, { mimeType }) => {
      const id = `drive-${++driveSeq}`;
      driveStore.set(id, Buffer.from(buffer));
      return { driveFileId: id, mimeType, bytes: buffer.length };
    },
    replaceCompanyFile: async (id, buffer, { mimeType }) => {
      driveStore.set(id, Buffer.from(buffer));
      return { driveFileId: id, mimeType, bytes: buffer.length };
    },
    streamCompanyFile: async () => {
      throw new Error("not used here");
    },
    deleteCompanyFile: async () => true,
  },
};

const { SECRET } = require("../config/jwt");
const { Doc_File } = require("../models/Files/Doc_File");

let mongo;
let server;
let base;
const me = { id: new mongoose.Types.ObjectId().toString(), subject: "employee", name: "Me", email: "me@grav.in", deptSlug: "ceo" };
const other = { id: new mongoose.Types.ObjectId().toString(), subject: "employee", name: "Other", email: "o@grav.in", deptSlug: "hr" };
const tokenFor = (u) => jwt.sign(u, SECRET, { expiresIn: "1h" });

async function call(user, method, url, body) {
  const headers = { Authorization: `Bearer ${tokenFor(user)}` };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${url}`, { method, headers, body: payload });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const row = (fields) =>
  Doc_File.create({ mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileKind: "sheet", bytes: 10, driveFileId: `drive-x-${Math.random()}`, ...fields });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const app = express();
  app.use(express.json());
  app.use("/api/files", require("../routes/Access/files"));
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server?.close();
  await mongoose.disconnect();
  await mongo?.stop();
});

test("Recent lists what I OPENED — mine or not — newest first, and opening is not editing", async () => {
  const mine = await row({ name: "Budget.xlsx", ownerId: me.id });
  const theirs = await row({ name: "Team plan.xlsx", ownerId: other.id });
  await row({ name: "Never opened.xlsx", ownerId: me.id });
  const before = (await Doc_File.findById(theirs._id)).updatedAt;

  assert.equal((await call(me, "POST", `/api/files/${mine._id}/opened`)).status, 200);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await call(me, "POST", `/api/files/${theirs._id}/opened`)).status, 200);

  const list = (await call(me, "GET", "/api/files/recent")).body.workbooks;
  assert.deepEqual(list.map((w) => w.name), ["Team plan.xlsx", "Budget.xlsx"]);
  assert.ok(list[0].openedAt);
  assert.deepEqual((await Doc_File.findById(theirs._id)).updatedAt, before, "Modified in Files does not move on open");
  assert.deepEqual((await call(other, "GET", "/api/files/recent")).body.workbooks, [], "Recent is per person");
});

test("pinned stay on top; removing takes it off my list only", async () => {
  const a = await row({ name: "Pinned.xlsx", ownerId: me.id });
  const b = await row({ name: "Later.xlsx", ownerId: me.id });
  await call(me, "POST", `/api/files/${a._id}/opened`);
  await new Promise((r) => setTimeout(r, 5));
  await call(me, "POST", `/api/files/${b._id}/opened`);
  assert.equal((await call(me, "PATCH", `/api/files/${a._id}/recent`, { pinned: true })).status, 200);
  let names = (await call(me, "GET", "/api/files/recent")).body.workbooks.map((w) => w.name);
  assert.equal(names[0], "Pinned.xlsx");
  // Opening again keeps the pin.
  await call(me, "POST", `/api/files/${a._id}/opened`);
  assert.equal((await call(me, "GET", "/api/files/recent")).body.workbooks.find((w) => w.name === "Pinned.xlsx").pinned, true);

  assert.equal((await call(me, "DELETE", `/api/files/${b._id}/recent`)).status, 200);
  names = (await call(me, "GET", "/api/files/recent")).body.workbooks.map((w) => w.name);
  assert.ok(!names.includes("Later.xlsx"));
  assert.ok(await Doc_File.findById(b._id), "the document itself stays");
  assert.equal((await call(me, "PATCH", `/api/files/${b._id}/recent`, { pinned: true })).status, 404, "not on my list any more");
  assert.equal((await call(me, "PATCH", `/api/files/${a._id}/recent`, { pinned: "yes" })).status, 400);
});

test("a workbook I may not read, or that is trashed, is not on Recent and cannot be opened", async () => {
  const secret = await row({ name: "Salaries.xlsx", ownerId: other.id, restricted: true });
  assert.equal((await call(me, "POST", `/api/files/${secret._id}/opened`)).status, 404);
  const gone = await row({ name: "Gone.xlsx", ownerId: me.id });
  await call(me, "POST", `/api/files/${gone._id}/opened`);
  await Doc_File.updateOne({ _id: gone._id }, { trashed: true });
  const names = (await call(me, "GET", "/api/files/recent")).body.workbooks.map((w) => w.name);
  assert.ok(!names.includes("Gone.xlsx") && !names.includes("Salaries.xlsx"));
  assert.equal((await call(me, "GET", "/api/files/recent")).status, 200);
  assert.equal((await fetch(`${base}/api/files/recent`)).status, 401, "signed in only");
});

test("Save: a new workbook is created in Sheets/, then saved over in place; ?mine=1 lists only mine", async () => {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("v1")]), "Q3.xlsx");
  form.append("folderPath", JSON.stringify(["Sheets"]));
  const created = await call(me, "POST", "/api/files", form);
  assert.equal(created.status, 201);
  const id = created.body.file.id;

  const again = new FormData();
  again.append("file", new Blob([Buffer.from("version 2")]), "Q3.xlsx");
  const saved = await call(me, "PUT", `/api/files/${id}/content`, again);
  assert.equal(saved.status, 200);
  const stored = await Doc_File.findById(id);
  assert.equal(driveStore.get(stored.driveFileId).toString(), "version 2");
  assert.equal(stored.bytes, 9);
  assert.equal(await Doc_File.countDocuments({ name: "Q3.xlsx" }), 1, "over, not beside");

  const empty = new FormData();
  assert.equal((await call(me, "PUT", `/api/files/${id}/content`, empty)).status, 400);
  const lockedRow = await row({ name: "Locked.xlsx", ownerId: other.id, restricted: true });
  const attempt = new FormData();
  attempt.append("file", new Blob([Buffer.from("x")]), "Locked.xlsx");
  assert.equal((await call(me, "PUT", `/api/files/${lockedRow._id}/content`, attempt)).status, 403);

  const mine = (await call(me, "GET", `/api/files?mine=1&folderPath=${encodeURIComponent('["Sheets"]')}`)).body.files.map((f) => f.name);
  assert.deepEqual(mine, ["Q3.xlsx"]);
});
