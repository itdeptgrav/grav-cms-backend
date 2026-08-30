// test/accountant/files-folders.route.test.js
//
// The company drive's TREE.
//
// Its own file rather than more of files.route.test.js, because the questions
// are different ones. That suite asks whether a document's bytes can escape;
// this one asks whether the drive can lose track of where its paperwork is —
// an empty folder that evaporates overnight, a move that renames a parent and
// strands its children, a delete that orphans a signed contract.
//
// The harness runs a STANDALONE mongod, which cannot do transactions. That is
// on purpose here: it means every move below exercises the non-atomic
// fallback, which is the path most likely to be wrong and the one a replica
// set would hide.
"use strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "files-folders-test-secret";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { SECRET } = require("../../config/jwt");
const { Doc_File } = require("../../models/Files/Doc_File");
const { Doc_Folder } = require("../../models/Files/Doc_Folder");

jest.mock("../../services/companyDrive.service", () => ({
  uploadCompanyFile: jest.fn(async (buf) => ({
    driveFileId: "drive-" + Math.random().toString(36).slice(2),
    mimeType: "application/pdf",
    bytes: buf.length,
  })),
  streamCompanyFile: jest.fn(async () => ({
    stream: require("stream").Readable.from([Buffer.from("PDFBYTES")]),
    meta: { name: "x.pdf", mimeType: "application/pdf", size: 8 },
  })),
  deleteCompanyFile: jest.fn(async () => true),
}));

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/files", require("../../routes/Access/files"));
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api/files`;

  /* The unique index is load-bearing — it is what stops two folders sharing a
     path and what makes the bootstrap race-safe. Built explicitly so the
     tests that depend on it are not at the mercy of autoIndex timing. */
  await Doc_Folder.init();
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const tokenFor = ({ id = new mongoose.Types.ObjectId().toString(), isAdmin = false } = {}) =>
  jwt.sign({ v: 2, id, name: "Filer", email: "f@demo.example", isAdmin }, SECRET, {
    expiresIn: "1h",
  });

async function call(path, { token, method = "GET", body: payload } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

/** The tree, as the file manager would load it. */
const listFolders = (token, qs = "") => call(`/folders${qs}`, { token });

/** One folder, made through the API — the way the UI makes one. */
async function makeFolder(token, { name, parentId = null, companyId = null } = {}) {
  const qs = companyId ? `?companyId=${companyId}` : "";
  const { status, body } = await call(`/folders${qs}`, {
    method: "POST",
    token,
    body: { name, parentId },
  });
  expect(status).toBe(201);
  return body.folder;
}

const seedDoc = (over = {}) =>
  Doc_File.create({
    name: "Invoice.pdf",
    mimeType: "application/pdf",
    fileKind: "pdf",
    bytes: 1234,
    driveFileId: "drive-abc",
    folderPath: ["Finance", "Invoices"],
    ownerName: "Priya N.",
    ...over,
  });

/* ═══════════════════════════════════════════════════════════════════════════
 * THE DOOR
 * ══════════════════════════════════════════════════════════════════════════ */

describe("folders: the door", () => {
  test("no session sees no tree and makes no folder", async () => {
    expect((await call("/folders")).status).toBe(401);
    expect((await call("/folders", { method: "POST", body: { name: "Secret" } })).status).toBe(401);

    /* Refused AND not written. A 401 that still created the folder would be
       the worst of both. */
    expect(await Doc_Folder.countDocuments({})).toBe(0);
  });

  test("no session cannot edit, trash, restore or delete one", async () => {
    const id = new mongoose.Types.ObjectId().toString();
    for (const [path, method] of [
      [`/folders/${id}`, "PATCH"],
      [`/folders/${id}/trash`, "POST"],
      [`/folders/${id}/restore`, "POST"],
      [`/folders/${id}`, "DELETE"],
    ]) {
      expect((await call(path, { method, body: {} })).status).toBe(401);
    }
  });

  test("an id that is not an id is not found, not a crash", async () => {
    expect((await call("/folders/nope", { method: "PATCH", token: tokenFor(), body: { name: "x" } })).status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE BUG THIS CHUNK EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════════ */

describe("folders survive a reload", () => {
  test("an EMPTY folder is still there on the next load", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Board Papers" });

    /* Nothing is filed in it. Under the old scaffold there was nothing to
       rebuild it from and it was gone — which is the whole reason this
       collection exists. */
    const { body } = await listFolders(token);
    expect(body.folders.some((f) => f.id === made.id && f.name === "Board Papers")).toBe(true);
  });

  test("the drive starts with the department tree, built once", async () => {
    const token = tokenFor();

    const first = await listFolders(token);
    expect(first.body.bootstrapped).toBe(true);
    const names = first.body.folders.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Finance", "Sales", "HR", "Compliance", "Budget"]));

    /* The icon vocabulary the manager draws with, preserved rather than
       re-guessed from the name. */
    expect(first.body.folders.find((f) => f.name === "Finance").variant).toBe("finance");
    /* Sub-folders hang off their department, not the root. */
    const finance = first.body.folders.find((f) => f.name === "Finance");
    const invoices = first.body.folders.find((f) => f.name === "Invoices");
    expect(invoices.parentId).toBe(finance.id);
    expect(invoices.path).toEqual(["Finance", "Invoices"]);

    const second = await listFolders(token);
    expect(second.body.bootstrapped).toBe(false);
    expect(second.body.folders).toHaveLength(first.body.folders.length);
  });

  test("a top-level folder reports no parent, and the client supplies the root", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Legal" });
    /* The drive itself is not a row — see the model. */
    expect(made.parentId).toBeNull();
    expect(made.path).toEqual(["Legal"]);
  });

  test("two folders cannot share a name in the same place", async () => {
    const token = tokenFor();
    await makeFolder(token, { name: "Reports" });

    const { status, body } = await call("/folders", {
      method: "POST",
      token,
      body: { name: "Reports" },
    });
    expect(status).toBe(409);
    expect(body.message).toMatch(/already a folder with that name/i);
  });

  test("a folder name is a name, not a path", async () => {
    const token = tokenFor();
    for (const name of ["", "   ", "Finance/Invoices", "..\\etc"]) {
      const { status } = await call("/folders", { method: "POST", token, body: { name } });
      expect(status).toBe(400);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * RENAME AND MOVE
 * ══════════════════════════════════════════════════════════════════════════ */

describe("rename", () => {
  test("a rename persists", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Old Name" });

    const { status, body } = await call(`/folders/${made.id}`, {
      method: "PATCH",
      token,
      body: { name: "New Name" },
    });
    expect(status).toBe(200);
    expect(body.folder.name).toBe("New Name");

    const { body: after } = await listFolders(token);
    expect(after.folders.find((f) => f.id === made.id).name).toBe("New Name");
  });

  test("renaming a parent rewrites its children's paths and its documents'", async () => {
    const token = tokenFor();
    const { body: tree } = await listFolders(token);
    const finance = tree.folders.find((f) => f.name === "Finance");
    const doc = await seedDoc({ folderPath: ["Finance", "Invoices"] });

    const { status, body } = await call(`/folders/${finance.id}`, {
      method: "PATCH",
      token,
      body: { name: "Accounts" },
    });
    expect(status).toBe(200);

    /* A rename IS a move of every path beneath it. If these two share a code
       path they cannot drift; this is the test that says so. */
    const { body: after } = await listFolders(token);
    expect(after.folders.find((f) => f.name === "Invoices").path).toEqual(["Accounts", "Invoices"]);
    expect(after.folders.find((f) => f.name === "Bank Statements").path).toEqual([
      "Accounts",
      "Bank Statements",
    ]);
    expect((await Doc_File.findById(doc._id)).folderPath).toEqual(["Accounts", "Invoices"]);
    expect(body.moved).toBeGreaterThan(0);
  });
});

describe("move", () => {
  test("moving a folder updates its documents' folderPath", async () => {
    const token = tokenFor();
    const { body: tree } = await listFolders(token);
    const invoices = tree.folders.find((f) => f.name === "Invoices");
    const admin = tree.folders.find((f) => f.name === "Admin");
    const doc = await seedDoc({ folderPath: ["Finance", "Invoices"] });

    const { status, body } = await call(`/folders/${invoices.id}`, {
      method: "PATCH",
      token,
      body: { parentId: admin.id },
    });

    expect(status).toBe(200);
    expect(body.folder.path).toEqual(["Admin", "Invoices"]);
    expect((await Doc_File.findById(doc._id)).folderPath).toEqual(["Admin", "Invoices"]);
  });

  test("moving a folder carries its whole subtree", async () => {
    const token = tokenFor();
    const { body: tree } = await listFolders(token);
    const finance = tree.folders.find((f) => f.name === "Finance");
    const admin = tree.folders.find((f) => f.name === "Admin");

    const deep = await makeFolder(token, {
      name: "2026",
      parentId: tree.folders.find((f) => f.name === "Invoices").id,
    });
    const doc = await seedDoc({ folderPath: ["Finance", "Invoices", "2026"] });

    await call(`/folders/${finance.id}`, { method: "PATCH", token, body: { parentId: admin.id } });

    const { body: after } = await listFolders(token);
    /* Three levels down, so a one-level rewrite would not be enough. */
    expect(after.folders.find((f) => f.id === deep.id).path).toEqual([
      "Admin",
      "Finance",
      "Invoices",
      "2026",
    ]);
    expect((await Doc_File.findById(doc._id)).folderPath).toEqual([
      "Admin",
      "Finance",
      "Invoices",
      "2026",
    ]);
  });

  test("a document in the trash moves with its folder", async () => {
    const token = tokenFor();
    const { body: tree } = await listFolders(token);
    const invoices = tree.folders.find((f) => f.name === "Invoices");
    const admin = tree.folders.find((f) => f.name === "Admin");
    const doc = await seedDoc({ folderPath: ["Finance", "Invoices"], trashed: true });

    await call(`/folders/${invoices.id}`, { method: "PATCH", token, body: { parentId: admin.id } });

    /* Otherwise restoring it later would put it back at a path no folder has
       occupied since the move. */
    expect((await Doc_File.findById(doc._id)).folderPath).toEqual(["Admin", "Invoices"]);
  });

  test("a folder can be moved out to the top level", async () => {
    const token = tokenFor();
    const { body: tree } = await listFolders(token);
    const invoices = tree.folders.find((f) => f.name === "Invoices");

    const { status, body } = await call(`/folders/${invoices.id}`, {
      method: "PATCH",
      token,
      body: { parentId: null },
    });
    expect(status).toBe(200);
    expect(body.folder.parentId).toBeNull();
    expect(body.folder.path).toEqual(["Invoices"]);
  });

  test("a folder cannot be moved into itself or its own descendant", async () => {
    const token = tokenFor();
    const { body: tree } = await listFolders(token);
    const finance = tree.folders.find((f) => f.name === "Finance");
    const invoices = tree.folders.find((f) => f.name === "Invoices");

    const intoSelf = await call(`/folders/${finance.id}`, {
      method: "PATCH",
      token,
      body: { parentId: finance.id },
    });
    expect(intoSelf.status).toBe(400);

    /* The one that actually detaches a branch from the root: the folder and
       its child would point at each other and never appear in a listing
       again. */
    const intoChild = await call(`/folders/${finance.id}`, {
      method: "PATCH",
      token,
      body: { parentId: invoices.id },
    });
    expect(intoChild.status).toBe(400);
    expect(intoChild.body.message).toMatch(/inside itself/i);

    const { body: after } = await listFolders(token);
    expect(after.folders.find((f) => f.id === finance.id).path).toEqual(["Finance"]);
  });

  test("a move reports whether it was atomic rather than letting the caller assume", async () => {
    const token = tokenFor();
    const { body: tree } = await listFolders(token);
    const invoices = tree.folders.find((f) => f.name === "Invoices");
    const admin = tree.folders.find((f) => f.name === "Admin");

    const { body } = await call(`/folders/${invoices.id}`, {
      method: "PATCH",
      token,
      body: { parentId: admin.id },
    });
    /* This harness is a standalone mongod, so the honest answer is false and
       the fallback did the work. On a replica set the same call says true. */
    expect(body.atomic).toBe(false);
  });

  test("a move onto an occupied name is refused, not silently duplicated", async () => {
    const token = tokenFor();
    const { body: tree } = await listFolders(token);
    const admin = tree.folders.find((f) => f.name === "Admin");
    const invoices = tree.folders.find((f) => f.name === "Invoices");
    await makeFolder(token, { name: "Invoices", parentId: admin.id });

    const { status } = await call(`/folders/${invoices.id}`, {
      method: "PATCH",
      token,
      body: { parentId: admin.id },
    });
    expect(status).toBe(409);
  });

  test("path and ownership are not editable", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Fixed" });
    for (const patch of [{ path: ["Hacked"] }, { companyId: new mongoose.Types.ObjectId().toString() }, { ownerId: "x" }]) {
      expect((await call(`/folders/${made.id}`, { method: "PATCH", token, body: patch })).status).toBe(400);
    }
    expect((await Doc_Folder.findById(made.id)).path).toEqual(["Fixed"]);
  });

  test("an empty edit says what is editable rather than reporting success", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Idle" });
    const { status, body } = await call(`/folders/${made.id}`, { method: "PATCH", token, body: {} });
    expect(status).toBe(400);
    expect(body.message).toMatch(/name.*parentId/);
  });

  test("star and tags persist on a folder too", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Watched" });

    const { status, body } = await call(`/folders/${made.id}`, {
      method: "PATCH",
      token,
      body: { starred: true, tags: ["Budget Support", " Budget Support "] },
    });
    expect(status).toBe(200);
    expect(body.folder.starred).toBe(true);
    expect(body.folder.tags).toEqual(["Budget Support"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * TRASH, RESTORE, DESTROY
 * ══════════════════════════════════════════════════════════════════════════ */

describe("folder trash", () => {
  test("a trashed folder leaves the tree and appears in the trash", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Temporary" });

    const { status, body } = await call(`/folders/${made.id}/trash`, { method: "POST", token });
    expect(status).toBe(200);
    expect(body.folder.trashed).toBe(true);

    const live = await listFolders(token);
    expect(live.body.folders.some((f) => f.id === made.id)).toBe(false);

    const trash = await listFolders(token, "?trash=1");
    expect(trash.body.folders.some((f) => f.id === made.id)).toBe(true);
  });

  test("restore puts it back where it was", async () => {
    const token = tokenFor();
    const { body: tree } = await listFolders(token);
    const finance = tree.folders.find((f) => f.name === "Finance");
    const made = await makeFolder(token, { name: "Quarterly", parentId: finance.id });

    await call(`/folders/${made.id}/trash`, { method: "POST", token });
    const { status, body } = await call(`/folders/${made.id}/restore`, { method: "POST", token });

    expect(status).toBe(200);
    expect(body.folder.trashed).toBe(false);
    /* Where it was, not at the top: trashing never touched parentId or path,
       which is exactly why it can come back. */
    expect(body.folder.parentId).toBe(finance.id);
    expect(body.folder.path).toEqual(["Finance", "Quarterly"]);
  });

  test("trashing a folder does not bury its documents", async () => {
    const token = tokenFor();
    const { body: tree } = await listFolders(token);
    const invoices = tree.folders.find((f) => f.name === "Invoices");
    const doc = await seedDoc({ folderPath: ["Finance", "Invoices"] });

    await call(`/folders/${invoices.id}/trash`, { method: "POST", token });

    /* Deliberate: a folder trashed by accident would otherwise mean finding
       and restoring a hundred documents one at a time. The documents keep
       their own flag and their own path. */
    const live = await Doc_File.findById(doc._id);
    expect(live.trashed).toBe(false);
    expect(live.folderPath).toEqual(["Finance", "Invoices"]);
  });

  test("both are idempotent", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Twice" });

    await call(`/folders/${made.id}/trash`, { method: "POST", token });
    expect((await call(`/folders/${made.id}/trash`, { method: "POST", token })).status).toBe(200);
    await call(`/folders/${made.id}/restore`, { method: "POST", token });
    expect((await call(`/folders/${made.id}/restore`, { method: "POST", token })).status).toBe(200);
    expect((await Doc_Folder.findById(made.id)).trashed).toBe(false);
  });

  test("a trashed folder is restorable but not editable", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Frozen" });
    await call(`/folders/${made.id}/trash`, { method: "POST", token });

    const { status } = await call(`/folders/${made.id}`, {
      method: "PATCH",
      token,
      body: { name: "Thawed" },
    });
    expect(status).toBe(409);
  });

  test("restoring onto a name somebody reused is refused with the fix", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Shared Name" });
    await call(`/folders/${made.id}/trash`, { method: "POST", token });
    await makeFolder(token, { name: "Shared Name" });

    const { status, body } = await call(`/folders/${made.id}/restore`, { method: "POST", token });
    expect(status).toBe(409);
    expect(body.message).toMatch(/rename one of them/i);
  });
});

describe("permanent folder delete", () => {
  test("a live folder cannot be destroyed in one call", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Alive" });

    const { status, body } = await call(`/folders/${made.id}`, { method: "DELETE", token });
    expect(status).toBe(409);
    expect(body.message).toMatch(/trash/i);
    expect(await Doc_Folder.findById(made.id)).not.toBeNull();
  });

  test("an empty, trashed folder deletes", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Gone" });
    await call(`/folders/${made.id}/trash`, { method: "POST", token });

    const { status } = await call(`/folders/${made.id}`, { method: "DELETE", token });
    expect(status).toBe(200);
    expect(await Doc_Folder.findById(made.id)).toBeNull();
  });

  test("a folder holding documents refuses, and says how many", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Occupied" });
    await seedDoc({ folderPath: ["Occupied"] });
    await call(`/folders/${made.id}/trash`, { method: "POST", token });

    const { status, body } = await call(`/folders/${made.id}`, { method: "DELETE", token });
    expect(status).toBe(409);
    expect(body.contains).toEqual({ folders: 0, files: 1 });
    /* The document is the point: deleting the folder would leave a row
       pointing at Drive bytes with no folder to reach them through. */
    expect(await Doc_File.countDocuments({ folderPath: ["Occupied"] })).toBe(1);
  });

  test("a document in the trash still counts as contents", async () => {
    const token = tokenFor();
    const made = await makeFolder(token, { name: "Occupied" });
    await seedDoc({ folderPath: ["Occupied"], trashed: true });
    await call(`/folders/${made.id}/trash`, { method: "POST", token });

    /* It still has bytes on Drive and a row that would be orphaned. */
    const { status } = await call(`/folders/${made.id}`, { method: "DELETE", token });
    expect(status).toBe(409);
  });

  test("a folder holding a child folder refuses", async () => {
    const token = tokenFor();
    const parent = await makeFolder(token, { name: "Parent" });
    await makeFolder(token, { name: "Child", parentId: parent.id });
    await call(`/folders/${parent.id}/trash`, { method: "POST", token });

    const { status, body } = await call(`/folders/${parent.id}`, { method: "DELETE", token });
    expect(status).toBe(409);
    expect(body.contains.folders).toBe(1);
  });

  test("a document nested deeper also blocks the delete", async () => {
    const token = tokenFor();
    const parent = await makeFolder(token, { name: "Top" });
    await makeFolder(token, { name: "Inner", parentId: parent.id });
    await seedDoc({ folderPath: ["Top", "Inner"] });
    await call(`/folders/${parent.id}/trash`, { method: "POST", token });

    const { body } = await call(`/folders/${parent.id}`, { method: "DELETE", token });
    expect(body.contains).toEqual({ folders: 1, files: 1 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * BOOKS, AND WHAT CAME BEFORE THEM
 * ══════════════════════════════════════════════════════════════════════════ */

describe("company partitioning", () => {
  const A = new mongoose.Types.ObjectId().toString();
  const B = new mongoose.Types.ObjectId().toString();

  test("one company's folders do not appear in another's tree", async () => {
    const token = tokenFor();
    const mine = await makeFolder(token, { name: "A Only", companyId: A });

    const theirs = await listFolders(token, `?companyId=${B}`);
    expect(theirs.body.folders.some((f) => f.id === mine.id)).toBe(false);

    const ours = await listFolders(token, `?companyId=${A}`);
    expect(ours.body.folders.some((f) => f.id === mine.id)).toBe(true);
  });

  test("another company's folder is not found, not forbidden", async () => {
    const token = tokenFor();
    const mine = await makeFolder(token, { name: "A Only", companyId: A });

    /* 404 rather than 403: a 403 on a specific id confirms the folder exists
       in somebody else's books, which is itself a leak. */
    for (const [path, method] of [
      [`/folders/${mine.id}?companyId=${B}`, "PATCH"],
      [`/folders/${mine.id}/trash?companyId=${B}`, "POST"],
      [`/folders/${mine.id}?companyId=${B}`, "DELETE"],
    ]) {
      const { status } = await call(path, { method, token, body: { name: "Stolen" } });
      expect(status).toBe(404);
    }
    expect((await Doc_Folder.findById(mine.id)).name).toBe("A Only");
  });

  test("a document filed under one company is not listed under another", async () => {
    const token = tokenFor();
    const mine = await seedDoc({ name: "A-Books.pdf", companyId: A });

    const theirs = await call(`/?companyId=${B}`, { token });
    expect(theirs.body.files.some((f) => f.id === String(mine._id))).toBe(false);
    const ours = await call(`/?companyId=${A}`, { token });
    expect(ours.body.files.some((f) => f.id === String(mine._id))).toBe(true);
  });

  test("a folder cannot be parented into another company's folder", async () => {
    const token = tokenFor();
    const theirs = await makeFolder(token, { name: "Theirs", companyId: B });

    const { status } = await call(`/folders?companyId=${A}`, {
      method: "POST",
      token,
      body: { name: "Mine", parentId: theirs.id },
    });
    expect(status).toBe(404);
  });
});

describe("what came before folders existed", () => {
  test("a document with only a folderPath is still listed, and still previews", async () => {
    const token = tokenFor();
    /* No Doc_Folder row anywhere near this path, and no companyId — exactly
       the shape of every document uploaded before this chunk. The client
       rebuilds the folder from the path; the server must not hide the
       document because the folder is missing. */
    const legacy = await seedDoc({ name: "Legacy.pdf", folderPath: ["Archive", "2019"] });

    const listed = await call("/", { token });
    const hit = listed.body.files.find((f) => f.id === String(legacy._id));
    expect(hit).toBeTruthy();
    expect(hit.folderPath).toEqual(["Archive", "2019"]);

    expect((await call(`/${legacy._id}/preview`, { token })).status).toBe(200);
  });

  test("a legacy document is visible from every set of books", async () => {
    const token = tokenFor();
    const legacy = await seedDoc({ name: "Legacy.pdf" });
    const company = new mongoose.Types.ObjectId().toString();

    /* The alternative — hiding it until somebody backfills companyId — would
       look exactly like the drive losing every document it had. */
    const scoped = await call(`/?companyId=${company}`, { token });
    expect(scoped.body.files.some((f) => f.id === String(legacy._id))).toBe(true);
  });

  test("a legacy folder-less path does not stop a real folder being made beside it", async () => {
    const token = tokenFor();
    await seedDoc({ folderPath: ["Archive", "2019"] });

    const made = await makeFolder(token, { name: "Archive" });
    expect(made.path).toEqual(["Archive"]);
  });
});
