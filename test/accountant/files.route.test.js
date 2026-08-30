// test/accountant/files.route.test.js
//
// The company drive's read gate, and its write gate.
//
// Almost every test here is about a REFUSAL, because that is where the value
// is: the whole design exists so that a provider URL never escapes and a link
// stops working when it should. The happy path is one test; the ways in are
// the rest.
//
// Drive itself is stubbed. What is under test is the gate, the token and the
// contract — not Google's client, which would make this a network test.
"use strict";

/* The download token derives its key from JWT_SECRET and throws without one.
   config/jwt falls back to a dev secret when it is unset, so the session half
   of these tests would pass while every mint threw a 500 — set it BEFORE the
   requires so both halves agree on the same secret. */
process.env.JWT_SECRET = process.env.JWT_SECRET || "files-route-test-secret";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { SECRET } = require("../../config/jwt");
const { Doc_File } = require("../../models/Files/Doc_File");
const { mintLetterToken } = require("../../utils/letterDownloadToken");

/* Stub the Drive service before the route requires it, so no test ever
   reaches the network or needs a service-account key. */
jest.mock("../../services/companyDrive.service", () => ({
  uploadCompanyFile: jest.fn(async (buf) => ({
    driveFileId: "drive-" + Math.random().toString(36).slice(2),
    mimeType: "application/pdf",
    bytes: buf.length,
  })),
  streamCompanyFile: jest.fn(async () => ({
    /* Required inside the factory: jest hoists mock factories above the
       imports, so an out-of-scope binding is not defined yet when it runs. */
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
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const tokenFor = ({ id = new mongoose.Types.ObjectId().toString(), isAdmin = false } = {}) =>
  jwt.sign({ v: 2, id, name: "Reader", email: "r@demo.example", isAdmin }, SECRET, {
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
  return { status: res.status, body, headers: res.headers };
}

const seedFile = (over = {}) =>
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

describe("authentication", () => {
  test("no session cannot ask for a preview", async () => {
    const row = await seedFile();
    expect((await call(`/${row._id}/preview`)).status).toBe(401);
  });

  test("a token signed with the wrong key is not a session", async () => {
    const row = await seedFile();
    const forged = jwt.sign({ id: "x" }, "not-the-secret");
    expect((await call(`/${row._id}/preview`, { token: forged })).status).toBe(401);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE LISTING
 * ══════════════════════════════════════════════════════════════════════════ */

describe("list", () => {
  test("no session cannot list the drive", async () => {
    await seedFile();
    expect((await call("/")).status).toBe(401);
  });

  test("returns nodes the file manager can render, and no provider URL", async () => {
    const row = await seedFile({ name: "Listed.pdf" });
    const { status, body } = await call("/", { token: tokenFor() });

    expect(status).toBe(200);
    const hit = body.files.find((f) => f.id === String(row._id));
    expect(hit).toMatchObject({
      kind: "file",
      name: "Listed.pdf",
      fileKind: "pdf",
      /* The field that switches the viewer's preview chain from "session
         blobs only" to "ask the server". Without it the UI would never call
         /preview for a stored document. */
      storage: "drive",
    });
    expect(JSON.stringify(body)).not.toMatch(/googleapis|drive\.google|drive-abc/);
  });

  test("trashed rows are out by default and in on request", async () => {
    const gone = await seedFile({ name: "Deleted.pdf", trashed: true });

    const live = await call("/", { token: tokenFor() });
    expect(live.body.files.some((f) => f.id === String(gone._id))).toBe(false);

    const trash = await call("/?trash=1", { token: tokenFor() });
    expect(trash.body.files.some((f) => f.id === String(gone._id))).toBe(true);
  });

  test("a restricted row is LISTED — concealment is not access control", async () => {
    /* It must appear, marked, so a folder does not silently look empty. The
       refusal is /preview's job, which its own test covers. */
    const row = await seedFile({ name: "Payroll.pdf", restricted: true, ownerId: new mongoose.Types.ObjectId() });
    const { body } = await call("/", { token: tokenFor() });
    const hit = body.files.find((f) => f.id === String(row._id));
    expect(hit).toBeTruthy();
    expect(hit.restricted).toBe(true);
  });

  test("folderPath matches exactly, not by prefix", async () => {
    const inner = await seedFile({ name: "Deep.pdf", folderPath: ["Finance", "Invoices"] });
    const outer = await seedFile({ name: "Shallow.pdf", folderPath: ["Finance"] });

    const { body } = await call(`/?folderPath=${encodeURIComponent(JSON.stringify(["Finance"]))}`, {
      token: tokenFor(),
    });
    const ids = body.files.map((f) => f.id);
    expect(ids).toContain(String(outer._id));
    expect(ids).not.toContain(String(inner._id));
  });

  test("a malformed folderPath is refused rather than ignored", async () => {
    const { status } = await call("/?folderPath=Finance", { token: tokenFor() });
    expect(status).toBe(400);
  });

  test("tag filter selects on tags", async () => {
    const tagged = await seedFile({ name: "Tagged.pdf", tags: ["Invoice"] });
    const { body } = await call("/?tag=Invoice", { token: tokenFor() });
    expect(body.files.every((f) => f.tags.includes("Invoice"))).toBe(true);
    expect(body.files.some((f) => f.id === String(tagged._id))).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT /preview HANDS BACK
 * ══════════════════════════════════════════════════════════════════════════ */

describe("preview", () => {
  test("returns our own download URL, and never the provider's", async () => {
    const row = await seedFile();
    const { status, body } = await call(`/${row._id}/preview`, { token: tokenFor() });

    expect(status).toBe(200);
    expect(body.canPreview).toBe(true);
    /* The name rides in the path so the browser's PDF viewer has a real
       title to print — the id and the token are still what authorise it. */
    expect(body.previewUrl).toContain(`/api/files/${row._id}/download/`);
    expect(body.downloadUrl).toContain(`/api/files/${row._id}/download/`);

    /* The point of the whole design: nothing in the response may mention
       Google, Drive, or the object's id there. */
    const json = JSON.stringify(body);
    expect(json).not.toMatch(/googleapis|drive\.google|drive-abc/);
  });

  test("an unpreviewable format still gets a download URL, but no preview URL", async () => {
    /* A workbook is previewable now; a slide deck is the honest example of
       a format with nothing to render it. */
    const row = await seedFile({
      name: "Deck.pptx",
      fileKind: "other",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const { body } = await call(`/${row._id}/preview`, { token: tokenFor() });
    expect(body.canPreview).toBe(false);
    expect(body.previewUrl).toBeNull();
    expect(body.downloadUrl).toContain("/download/");
  });

  test("a trashed document is gone, not merely hidden", async () => {
    const row = await seedFile({ trashed: true });
    expect((await call(`/${row._id}/preview`, { token: tokenFor() })).status).toBe(404);
  });

  test("an unknown id is 404 and says nothing else", async () => {
    const ghost = new mongoose.Types.ObjectId();
    const { status, body } = await call(`/${ghost}/preview`, { token: tokenFor() });
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toMatch(/drive|google/i);
  });

  test("a restricted document is refused to everyone but its owner and an admin", async () => {
    const owner = new mongoose.Types.ObjectId().toString();
    const row = await seedFile({ restricted: true, ownerId: owner });

    expect((await call(`/${row._id}/preview`, { token: tokenFor() })).status).toBe(403);
    expect((await call(`/${row._id}/preview`, { token: tokenFor({ id: owner }) })).status).toBe(200);
    expect((await call(`/${row._id}/preview`, { token: tokenFor({ isAdmin: true }) })).status).toBe(
      200,
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT /download REFUSES
 *
 * Every one of these is a way somebody could otherwise read bytes they are
 * not entitled to.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("download", () => {
  const linkFor = async (row, who = tokenFor()) => {
    const { body } = await call(`/${row._id}/preview`, { token: who });
    return body.downloadUrl.slice(body.downloadUrl.indexOf("/api/files") + "/api/files".length);
  };

  test("a valid token AND a session streams the bytes inline", async () => {
    const row = await seedFile();
    const session = tokenFor();
    const path = await linkFor(row, session);

    const { status, body, headers } = await call(path, { token: session });
    expect(status).toBe(200);
    expect(body.raw).toBe("PDFBYTES");
    expect(headers.get("content-disposition")).toMatch(/^inline/);
    /* Never in a shared cache. */
    expect(headers.get("cache-control")).toMatch(/private/);
  });

  test("dl=1 downloads instead of rendering inline", async () => {
    const row = await seedFile();
    const session = tokenFor();
    const path = await linkFor(row, session);
    const { headers } = await call(`${path}&dl=1`, { token: session });
    expect(headers.get("content-disposition")).toMatch(/^attachment/);
  });

  test("the token alone is not enough — a copied URL is not a bearer grant", async () => {
    const row = await seedFile();
    const path = await linkFor(row);
    expect((await call(path)).status).toBe(401);
  });

  test("a session alone is not enough — ids cannot be guessed", async () => {
    const row = await seedFile();
    expect((await call(`/${row._id}/download`, { token: tokenFor() })).status).toBe(404);
  });

  test("a token for ANOTHER document does not open this one", async () => {
    const a = await seedFile();
    const b = await seedFile({ name: "Other.pdf" });
    const stolen = mintLetterToken({ docId: a._id, scope: "file", subject: "u" });
    const { status } = await call(`/${b._id}/download?t=${encodeURIComponent(stolen)}`, {
      token: tokenFor(),
    });
    expect(status).toBe(404);
  });

  test("an HR letter token does not open a drive file", async () => {
    const row = await seedFile();
    /* Correctly signed, correct document id, WRONG scope — this is the test
       that earns reusing the letters token util instead of copying it. */
    const wrongScope = mintLetterToken({ docId: row._id, scope: "hr", subject: "u" });
    const { status } = await call(`/${row._id}/download?t=${encodeURIComponent(wrongScope)}`, {
      token: tokenFor(),
    });
    expect(status).toBe(404);
  });

  test("an expired token stops working", async () => {
    const row = await seedFile();
    const expired = mintLetterToken({
      docId: row._id,
      scope: "file",
      subject: "u",
      ttlMs: -1000,
    });
    const { status } = await call(`/${row._id}/download?t=${encodeURIComponent(expired)}`, {
      token: tokenFor(),
    });
    expect(status).toBe(404);
  });

  test("a tampered token stops working", async () => {
    const row = await seedFile();
    const good = mintLetterToken({ docId: row._id, scope: "file", subject: "u" });
    const tampered = good.slice(0, -2) + (good.endsWith("A") ? "BB" : "AA");
    const { status } = await call(`/${row._id}/download?t=${encodeURIComponent(tampered)}`, {
      token: tokenFor(),
    });
    expect(status).toBe(404);
  });

  test("access lost after the link was minted takes effect on the next read", async () => {
    /* The reason the gate runs on every request rather than once. */
    const row = await seedFile();
    const session = tokenFor();
    const path = await linkFor(row, session);
    expect((await call(path, { token: session })).status).toBe(200);

    await Doc_File.findByIdAndUpdate(row._id, {
      restricted: true,
      ownerId: new mongoose.Types.ObjectId(),
    });

    expect((await call(path, { token: session })).status).toBe(404);
  });
});


/* ═══════════════════════════════════════════════════════════════════════════
 * THE WRITE GATE
 *
 * Same shape of argument as the read gate above: the interesting tests are
 * the refusals. An edit endpoint's job is not "it saved the name" — it is
 * "it saved ONLY the name, only for someone allowed to, and only on a
 * document that is really theirs to change".
 * ══════════════════════════════════════════════════════════════════════════ */

const patchIt = (id, body, token) => call(`/${id}`, { method: "PATCH", body, token });
const reload = (id) => Doc_File.findById(id);

describe("mutation: the door", () => {
  test("no session cannot edit, trash, restore or delete", async () => {
    const row = await seedFile();
    const id = String(row._id);

    expect((await patchIt(id, { name: "Renamed.pdf" })).status).toBe(401);
    expect((await call(`/${id}/trash`, { method: "POST" })).status).toBe(401);
    expect((await call(`/${id}/restore`, { method: "POST" })).status).toBe(401);
    expect((await call(`/${id}`, { method: "DELETE" })).status).toBe(401);

    /* Not merely refused — unchanged. A 401 that still wrote would be the
       worst of both. */
    expect((await reload(id)).name).toBe("Invoice.pdf");
  });

  test("an id that is not an id is not found, not a crash", async () => {
    expect((await patchIt("not-an-id", { starred: true }, tokenFor())).status).toBe(404);
    expect(
      (await call("/not-an-id/trash", { method: "POST", token: tokenFor() })).status,
    ).toBe(404);
  });

  test("a document that does not exist is not found", async () => {
    const ghost = new mongoose.Types.ObjectId().toString();
    expect((await patchIt(ghost, { starred: true }, tokenFor())).status).toBe(404);
  });
});

describe("mutation: what may change", () => {
  test("rename persists and comes back in the response node", async () => {
    const row = await seedFile({ name: "Before.pdf" });
    const { status, body } = await patchIt(String(row._id), { name: "After.pdf" }, tokenFor());

    expect(status).toBe(200);
    /* The frontend replaces its node with this object wholesale, so the
       response carrying the new name is as load-bearing as the write. */
    expect(body.file).toMatchObject({ id: String(row._id), name: "After.pdf" });
    expect((await reload(row._id)).name).toBe("After.pdf");
  });

  test("move rewrites folderPath", async () => {
    const row = await seedFile();
    const { status, body } = await patchIt(
      String(row._id),
      { folderPath: ["Sales", "Customer Contracts"] },
      tokenFor(),
    );

    expect(status).toBe(200);
    expect(body.file.folderPath).toEqual(["Sales", "Customer Contracts"]);
    expect((await reload(row._id)).folderPath).toEqual(["Sales", "Customer Contracts"]);
  });

  test("a move to the drive root is a real move, not an empty edit", async () => {
    const row = await seedFile();
    const { status, body } = await patchIt(String(row._id), { folderPath: [] }, tokenFor());

    expect(status).toBe(200);
    expect(body.file.folderPath).toEqual([]);
  });

  test("star persists — the whole point of this chunk", async () => {
    const row = await seedFile();
    expect(row.starred).toBe(false);

    await patchIt(String(row._id), { starred: true }, tokenFor());
    expect((await reload(row._id)).starred).toBe(true);

    await patchIt(String(row._id), { starred: false }, tokenFor());
    expect((await reload(row._id)).starred).toBe(false);
  });

  test("tags are trimmed, deduped and kept simple", async () => {
    const row = await seedFile();
    const { status, body } = await patchIt(
      String(row._id),
      { tags: ["Finance", " Finance ", "FY 2026-27", ""] },
      tokenFor(),
    );

    expect(status).toBe(200);
    expect(body.file.tags).toEqual(["Finance", "FY 2026-27"]);
  });

  test("several fields in one call, because that is one save to the user", async () => {
    const row = await seedFile();
    const { status, body } = await patchIt(
      String(row._id),
      { name: "Combined.pdf", starred: true, folderPath: ["Admin"] },
      tokenFor(),
    );

    expect(status).toBe(200);
    expect(body.file).toMatchObject({
      name: "Combined.pdf",
      starred: true,
      folderPath: ["Admin"],
    });
  });
});

describe("mutation: what may not", () => {
  const bad = async (patch, expectMessage) => {
    const row = await seedFile();
    const { status, body } = await patchIt(String(row._id), patch, tokenFor());
    expect(status).toBe(400);
    if (expectMessage) expect(body.message).toMatch(expectMessage);
    return row;
  };

  test("a document cannot be left without a name", async () => {
    await bad({ name: "   " }, /needs a name/i);
  });

  test("a name cannot smuggle a path separator", async () => {
    await bad({ name: "../../etc/passwd" }, /cannot contain/i);
  });

  test("a name must be text", async () => {
    await bad({ name: 42 });
  });

  test("folderPath must be a list of names", async () => {
    await bad({ folderPath: "Finance/Invoices" }, /must be a list/i);
    await bad({ folderPath: ["Finance", { $ne: null }] }, /list of folder names/i);
    await bad({ folderPath: ["Finance", "  "] }, /empty/i);
  });

  test("starred must be a boolean, not a truthy string", async () => {
    await bad({ starred: "yes" }, /true or false/i);
  });

  test("a tag cannot be arbitrary text", async () => {
    await bad({ tags: ["<script>alert(1)</script>"] }, /not a usable tag/i);
    await bad({ tags: "Finance" }, /must be a list/i);
  });

  test("the bytes cannot be repointed at another document", async () => {
    const row = await seedFile();
    const { status, body } = await patchIt(
      String(row._id),
      { driveFileId: "drive-somebody-elses" },
      tokenFor(),
    );

    expect(status).toBe(400);
    expect(body.message).toMatch(/driveFileId/);
    /* Refused BY NAME and not applied. A silent drop would leave the caller
       believing the file now points somewhere else. */
    expect((await reload(row._id)).driveFileId).toBe("drive-abc");
  });

  test("ownership, storage and size are not editable", async () => {
    for (const patch of [
      { ownerId: new mongoose.Types.ObjectId().toString() },
      { createdBy: new mongoose.Types.ObjectId().toString() },
      { storage: "drive" },
      { bytes: 1 },
      { mimeType: "text/html" },
    ]) {
      await bad(patch);
    }
  });

  test("a rename cannot also empty the trash", async () => {
    const row = await seedFile();
    const { status, body } = await patchIt(
      String(row._id),
      { name: "Sneaky.pdf", trashed: true },
      tokenFor(),
    );

    expect(status).toBe(400);
    expect(body.message).toMatch(/\/trash and \/restore/);
    /* The whole edit is refused, not half-applied. */
    expect((await reload(row._id)).name).toBe("Invoice.pdf");
  });

  test("an empty edit says what is editable rather than reporting success", async () => {
    const row = await seedFile();
    const { status, body } = await patchIt(String(row._id), {}, tokenFor());
    expect(status).toBe(400);
    expect(body.message).toMatch(/name.*folderPath.*starred/);
  });
});

describe("mutation: who may change it", () => {
  test("any signed-in person may edit an unrestricted document — stated, not implied", async () => {
    const row = await seedFile({ ownerId: new mongoose.Types.ObjectId() });
    const stranger = tokenFor();

    expect((await patchIt(String(row._id), { name: "Anyone.pdf" }, stranger)).status).toBe(200);
  });

  test("a restricted document is refused to everyone but its owner and an admin", async () => {
    const owner = new mongoose.Types.ObjectId();
    const row = await seedFile({ restricted: true, ownerId: owner });

    expect((await patchIt(String(row._id), { name: "No.pdf" }, tokenFor())).status).toBe(403);
    expect(
      (await patchIt(String(row._id), { name: "Owner.pdf" }, tokenFor({ id: String(owner) })))
        .status,
    ).toBe(200);
    expect(
      (await patchIt(String(row._id), { name: "Admin.pdf" }, tokenFor({ isAdmin: true }))).status,
    ).toBe(200);
  });

  test("nobody can lock a colleague out of a document they do not own", async () => {
    const row = await seedFile({ ownerId: new mongoose.Types.ObjectId() });
    const { status, body } = await patchIt(String(row._id), { restricted: true }, tokenFor());

    expect(status).toBe(400);
    expect(body.message).toMatch(/owner or an admin/i);
    expect((await reload(row._id)).restricted).toBe(false);
  });

  test("the owner and an admin can, in both directions", async () => {
    const owner = new mongoose.Types.ObjectId();
    const row = await seedFile({ ownerId: owner });

    expect(
      (await patchIt(String(row._id), { restricted: true }, tokenFor({ id: String(owner) })))
        .status,
    ).toBe(200);
    expect((await reload(row._id)).restricted).toBe(true);

    expect(
      (await patchIt(String(row._id), { restricted: false }, tokenFor({ isAdmin: true }))).status,
    ).toBe(200);
    expect((await reload(row._id)).restricted).toBe(false);
  });

  test("restating the lock you cannot change is not an edit you can make", async () => {
    const row = await seedFile({ ownerId: new mongoose.Types.ObjectId() });
    /* restricted: false on an already-unrestricted row is a no-op, so it is
       allowed through — the guard is on the CHANGE, not the mention. */
    expect((await patchIt(String(row._id), { restricted: false }, tokenFor())).status).toBe(200);
  });
});

describe("trash and restore", () => {
  test("trashing takes it out of the drive and puts it in the trash", async () => {
    const row = await seedFile({ name: "Trashable.pdf" });
    const id = String(row._id);
    const token = tokenFor();

    const { status, body } = await call(`/${id}/trash`, { method: "POST", token });
    expect(status).toBe(200);
    expect(body.file.trashed).toBe(true);

    const listed = await call("/", { token });
    expect(listed.body.files.some((f) => f.id === id)).toBe(false);

    const trash = await call("/?trash=1", { token });
    expect(trash.body.files.some((f) => f.id === id)).toBe(true);
  });

  test("trashing keeps folderPath, so restore knows where it goes back", async () => {
    const row = await seedFile();
    const token = tokenFor();

    await call(`/${row._id}/trash`, { method: "POST", token });
    const { body } = await call(`/${row._id}/restore`, { method: "POST", token });

    expect(body.file.trashed).toBe(false);
    expect(body.file.folderPath).toEqual(["Finance", "Invoices"]);
  });

  test("both are idempotent — a second click is the same answer", async () => {
    const row = await seedFile();
    const token = tokenFor();

    await call(`/${row._id}/trash`, { method: "POST", token });
    expect((await call(`/${row._id}/trash`, { method: "POST", token })).status).toBe(200);
    expect((await reload(row._id)).trashed).toBe(true);

    await call(`/${row._id}/restore`, { method: "POST", token });
    expect((await call(`/${row._id}/restore`, { method: "POST", token })).status).toBe(200);
    expect((await reload(row._id)).trashed).toBe(false);
  });

  test("a trashed document is restorable but not editable", async () => {
    const row = await seedFile();
    const token = tokenFor();
    await call(`/${row._id}/trash`, { method: "POST", token });

    const { status, body } = await patchIt(String(row._id), { name: "InTrash.pdf" }, token);
    expect(status).toBe(409);
    expect(body.message).toMatch(/restore this document/i);
    expect((await reload(row._id)).name).toBe("Invoice.pdf");
  });

  test("a restricted document cannot be trashed by a stranger", async () => {
    const row = await seedFile({ restricted: true, ownerId: new mongoose.Types.ObjectId() });
    expect((await call(`/${row._id}/trash`, { method: "POST", token: tokenFor() })).status).toBe(
      403,
    );
    expect((await reload(row._id)).trashed).toBe(false);
  });

  test("a trashed document is still refused a preview", async () => {
    const row = await seedFile();
    const token = tokenFor();
    await call(`/${row._id}/trash`, { method: "POST", token });

    /* mayWrite lets a trashed row be restored; mayRead must NOT let it be
       read. The two gates part company here, which is the reason they are
       two functions. */
    expect((await call(`/${row._id}/preview`, { token })).status).toBe(404);
  });
});

describe("permanent delete", () => {
  const drive = require("../../services/companyDrive.service");

  test("a live document cannot be destroyed in one call", async () => {
    const row = await seedFile();
    const { status, body } = await call(`/${row._id}`, { method: "DELETE", token: tokenFor() });

    expect(status).toBe(409);
    expect(body.message).toMatch(/trash/i);
    expect(await reload(row._id)).not.toBeNull();
  });

  test("out of the trash, the row and the bytes both go", async () => {
    const row = await seedFile({ driveFileId: "drive-doomed" });
    const token = tokenFor();
    await call(`/${row._id}/trash`, { method: "POST", token });

    drive.deleteCompanyFile.mockClear();
    const { status, body } = await call(`/${row._id}`, { method: "DELETE", token });

    expect(status).toBe(200);
    expect(body).toMatchObject({ id: String(row._id), driveDeleted: true });
    expect(drive.deleteCompanyFile).toHaveBeenCalledWith("drive-doomed");
    expect(await reload(row._id)).toBeNull();
  });

  test("Drive failing does not resurrect the row — and is reported, not hidden", async () => {
    const row = await seedFile({ driveFileId: "drive-stuck" });
    const token = tokenFor();
    await call(`/${row._id}/trash`, { method: "POST", token });

    drive.deleteCompanyFile.mockResolvedValueOnce(false);
    const { status, body } = await call(`/${row._id}`, { method: "DELETE", token });

    /* The documented trade-off: an orphaned Drive object rather than a row
       pointing at bytes the user believes are gone. `driveDeleted: false` is
       how an admin learns there is something to sweep up. */
    expect(status).toBe(200);
    expect(body.driveDeleted).toBe(false);
    expect(await reload(row._id)).toBeNull();
  });

  test("a restricted document cannot be deleted by a stranger", async () => {
    const owner = new mongoose.Types.ObjectId();
    const row = await seedFile({ restricted: true, ownerId: owner, trashed: true });

    expect((await call(`/${row._id}`, { method: "DELETE", token: tokenFor() })).status).toBe(403);
    expect(await reload(row._id)).not.toBeNull();
  });
});

describe("reading still works after writing", () => {
  test("a renamed, moved, starred document still previews and still leaks nothing", async () => {
    const row = await seedFile();
    const token = tokenFor();

    await patchIt(
      String(row._id),
      { name: "Renamed.pdf", folderPath: ["Admin"], starred: true },
      token,
    );

    const { status, body } = await call(`/${row._id}/preview`, { token });
    expect(status).toBe(200);
    expect(body.file).toMatchObject({ name: "Renamed.pdf", starred: true });
    expect(body.previewUrl).toMatch(/\/api\/files\/[^/]+\/download\/[^?]+\?t=/);
    expect(JSON.stringify(body)).not.toMatch(/googleapis|drive\.google|drive-abc/);
  });
});


/* ═══════════════════════════════════════════════════════════════════════════
 * WHICH VIEWER
 *
 * /preview stopped answering "can I frame this?" and started answering "what
 * IS this?" — because the first question has only two wrong answers and the
 * second one has a right one for every file. These tests pin the mapping,
 * since it is now the single place the client's rendering decision comes
 * from.
 * ══════════════════════════════════════════════════════════════════════════ */

const drive = require("../../services/companyDrive.service");

describe("preview metadata", () => {
  const previewOf = async (over) => {
    const row = await seedFile(over);
    const { status, body } = await call(`/${row._id}/preview`, { token: tokenFor() });
    return { row, status, body };
  };

  test("an image says image, and offers a URL to draw it from", async () => {
    const { row, status, body } = await previewOf({
      name: "Scan.png",
      mimeType: "image/png",
      fileKind: "image",
      bytes: 4096,
    });

    expect(status).toBe(200);
    expect(body.previewKind).toBe("image");
    expect(body.canPreview).toBe(true);
    expect(body.previewUrl).toMatch(/\/api\/files\/[^/]+\/download\/[^?]+\?t=/);
    /* Flat, so choosing a viewer does not mean reaching into `file`. */
    expect(body).toMatchObject({ name: "Scan.png", mimeType: "image/png", size: 4096 });
    expect(String(row._id)).toBe(body.file.id);
  });

  test("a PDF says pdf", async () => {
    const { body } = await previewOf({ name: "Contract.pdf", mimeType: "application/pdf" });
    expect(body.previewKind).toBe("pdf");
    expect(body.canPreview).toBe(true);
    expect(body.previewUrl).toBeTruthy();
  });

  test("a CSV says sheet — it is a table, and it reads as one", async () => {
    const { body } = await previewOf({ name: "Ledger.csv", mimeType: "text/csv", fileKind: "sheet" });

    expect(body.previewKind).toBe("sheet");
    expect(body.canPreview).toBe(true);
    /* Grids are fetched as JSON and drawn by us. A previewUrl here would
       invite a frame, which is the one way to render a document unsafely. */
    expect(body.previewUrl).toBeNull();
    expect(body.downloadUrl).toBeTruthy();
  });

  test("a workbook says sheet, in both the modern and the legacy format", async () => {
    const xlsx = await previewOf({
      name: "Budget.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileKind: "sheet",
    });
    expect(xlsx.body.previewKind).toBe("sheet");
    expect(xlsx.body.canPreview).toBe(true);

    /* .xls is why this uses SheetJS rather than exceljs, which cannot read
       the legacy format at all. */
    const xls = await previewOf({
      name: "Ledger2019.xls",
      mimeType: "application/vnd.ms-excel",
      fileKind: "sheet",
    });
    expect(xls.body.previewKind).toBe("sheet");
  });

  test("a Word document says unsupported, and still offers the download", async () => {
    const { body } = await previewOf({
      name: "Policy.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileKind: "doc",
    });

    expect(body.previewKind).toBe("unsupported");
    expect(body.canPreview).toBe(false);
    expect(body.previewUrl).toBeNull();
    /* The fallback is a real state with real actions, not an empty frame —
       so it needs somewhere for Download and Open original to point. */
    expect(body.downloadUrl).toMatch(/\/api\/files\/[^/]+\/download\/[^?]+\?t=/);
  });

  test("an image format browsers cannot draw is unsupported, not a broken frame", async () => {
    const { body } = await previewOf({ name: "Plate.tiff", mimeType: "image/tiff", fileKind: "image" });
    /* The old rule was `fileKind === "image"`, which called this previewable
       and produced a broken-image glyph the reader would read as data loss. */
    expect(body.previewKind).toBe("unsupported");
  });

  test('the preview URL carries the document name, so a framed PDF is not titled "download"', async () => {
    const { body } = await previewOf({ name: "Q3 Report.pdf", mimeType: "application/pdf" });
    /* The browser's built-in PDF viewer titles the document from the last
       path segment, not from Content-Disposition. Before this, every PDF in
       the app was captioned "download" in the reader's face. */
    expect(decodeURIComponent(body.previewUrl.split("?")[0])).toMatch(/\/Q3 Report\.pdf$/);
  });

  test("no metadata route leaks a provider URL", async () => {
    const { body } = await previewOf({ name: "Scan.png", mimeType: "image/png" });
    expect(JSON.stringify(body)).not.toMatch(/googleapis|drive\.google|drive-abc/);
  });

  test("a restricted document is refused a preview, whatever its format", async () => {
    const owner = new mongoose.Types.ObjectId();
    const row = await seedFile({ restricted: true, ownerId: owner, mimeType: "image/png" });

    expect((await call(`/${row._id}/preview`, { token: tokenFor() })).status).toBe(403);
    expect(
      (await call(`/${row._id}/preview`, { token: tokenFor({ id: String(owner) }) })).status,
    ).toBe(200);
  });

  test("a trashed document has no preview at all", async () => {
    const row = await seedFile({ trashed: true });
    /* Explicitly 404 and not 200-with-no-preview: the document is not
       missing a renderer, it is not in the drive. */
    expect((await call(`/${row._id}/preview`, { token: tokenFor() })).status).toBe(404);
  });

  test("a document that is not there is not found", async () => {
    const ghost = new mongoose.Types.ObjectId().toString();
    expect((await call(`/${ghost}/preview`, { token: tokenFor() })).status).toBe(404);
    expect((await call("/not-an-id/preview", { token: tokenFor() })).status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * READING TEXT
 * ══════════════════════════════════════════════════════════════════════════ */

describe("text preview", () => {
  const asStream = (content) => ({
    stream: require("stream").Readable.from([Buffer.from(content)]),
    meta: { name: "x.csv", mimeType: "text/csv", size: content.length },
  });

  test("a text document comes back as a string, through the same gate as everything else", async () => {
    const row = await seedFile({ name: "Notes.txt", mimeType: "text/plain" });
    drive.streamCompanyFile.mockResolvedValueOnce(asStream("Date,Amount\n2026-08-01,1200\n"));

    const { status, body } = await call(`/${row._id}/text`, { token: tokenFor() });
    expect(status).toBe(200);
    expect(body.text).toContain("2026-08-01,1200");
    expect(body.truncated).toBe(false);
  });

  test("no session reads nothing", async () => {
    const row = await seedFile({ name: "Notes.txt", mimeType: "text/plain" });
    expect((await call(`/${row._id}/text`)).status).toBe(401);
  });

  test("a restricted document is refused, a trashed one is not found", async () => {
    const restricted = await seedFile({
      name: "Private.txt",
      mimeType: "text/plain",
      restricted: true,
      ownerId: new mongoose.Types.ObjectId(),
    });
    expect((await call(`/${restricted._id}/text`, { token: tokenFor() })).status).toBe(403);

    const trashed = await seedFile({ name: "Old.txt", mimeType: "text/plain", trashed: true });
    expect((await call(`/${trashed._id}/text`, { token: tokenFor() })).status).toBe(404);
  });

  test("a spreadsheet is refused here — it has its own endpoint and its own cap", async () => {
    const row = await seedFile({
      name: "Budget.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const { status, body } = await call(`/${row._id}/text`, { token: tokenFor() });
    expect(status).toBe(415);
    expect(body.previewKind).toBe("sheet");
  });

  test("a long document is capped, and says so", async () => {
    const row = await seedFile({ name: "Huge.log", mimeType: "text/plain" });
    drive.streamCompanyFile.mockResolvedValueOnce(asStream("x".repeat(700 * 1024)));

    const { status, body } = await call(`/${row._id}/text`, { token: tokenFor() });
    expect(status).toBe(200);
    expect(body.truncated).toBe(true);
    /* Cut at the limit, not merely flagged — the point is the response stays
       a sane size. */
    expect(body.text.length).toBe(512 * 1024);
  });

  test("a binary file wearing a text type is refused, not rendered as mojibake", async () => {
    const row = await seedFile({ name: "Fake.txt", mimeType: "text/plain" });
    drive.streamCompanyFile.mockResolvedValueOnce({
      stream: require("stream").Readable.from([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])]),
      meta: { name: "Fake.txt", mimeType: "text/plain", size: 6 },
    });

    const { status, body } = await call(`/${row._id}/text`, { token: tokenFor() });
    expect(status).toBe(415);
    expect(body.message).toMatch(/not readable as text/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT MAY BE SERVED INLINE
 *
 * The bug these pin: /download used to send `Content-Disposition: inline` for
 * ANY type. An uploaded .html or .svg opened from that URL executed its
 * scripts on the API's own origin, carrying the session cookie — stored XSS,
 * uploadable by any signed-in person.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("download disposition", () => {
  const fetchWith = async (row, token) => {
    const t = mintLetterToken({ docId: row._id, scope: "file", subject: "u" });
    return call(`/${row._id}/download?t=${encodeURIComponent(t)}`, { token });
  };

  test("an image is served inline, so the viewer can draw it", async () => {
    const row = await seedFile({ name: "Scan.png", mimeType: "image/png" });
    drive.streamCompanyFile.mockResolvedValueOnce({
      stream: require("stream").Readable.from([Buffer.from("PNG")]),
      meta: { name: "Scan.png", mimeType: "image/png", size: 3 },
    });

    const { headers } = await fetchWith(row, tokenFor());
    expect(headers.get("content-disposition")).toMatch(/^inline/);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("HTML and SVG are forced to download, never rendered on this origin", async () => {
    for (const mimeType of ["text/html", "image/svg+xml"]) {
      const row = await seedFile({ name: "payload", mimeType });
      drive.streamCompanyFile.mockResolvedValueOnce({
        stream: require("stream").Readable.from([Buffer.from("<script>alert(1)</script>")]),
        meta: { name: "payload", mimeType, size: 25 },
      });

      const { headers } = await fetchWith(row, tokenFor());
      expect(headers.get("content-disposition")).toMatch(/^attachment/);
    }
  });

  test("an explicit download request still wins over an inline type", async () => {
    const row = await seedFile({ name: "Scan.png", mimeType: "image/png" });
    drive.streamCompanyFile.mockResolvedValueOnce({
      stream: require("stream").Readable.from([Buffer.from("PNG")]),
      meta: { name: "Scan.png", mimeType: "image/png", size: 3 },
    });

    const t = mintLetterToken({ docId: row._id, scope: "file", subject: "u" });
    const { headers } = await call(`/${row._id}/download?t=${encodeURIComponent(t)}&dl=1`, {
      token: tokenFor(),
    });
    expect(headers.get("content-disposition")).toMatch(/^attachment/);
  });
});


/* ═══════════════════════════════════════════════════════════════════════════
 * WORKBOOKS
 *
 * Real .xlsx bytes, built by the same library that reads them, so these test
 * the endpoint rather than a fixture nobody can regenerate. The cap is the
 * thing most worth pinning: a preview that quietly renders the first hundred
 * rows of a fifty-thousand-row ledger, without saying so, is how somebody
 * quotes a total that is not the total.
 * ══════════════════════════════════════════════════════════════════════════ */

const XLSX = require("xlsx");

describe("sheet preview", () => {
  /** A workbook as bytes. `sheets` is { name: rows }. */
  const workbook = (sheets) => {
    const wb = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
    }
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  };

  const servesBytes = (buf) =>
    drive.streamCompanyFile.mockResolvedValueOnce({
      stream: require("stream").Readable.from([buf]),
      meta: { name: "wb.xlsx", mimeType: "application/octet-stream", size: buf.length },
    });

  const seedBook = (over = {}) =>
    seedFile({
      name: "Budget.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileKind: "sheet",
      bytes: 4096,
      ...over,
    });

  test("a workbook comes back as a grid of strings", async () => {
    const row = await seedBook();
    servesBytes(
      workbook({ Summary: [["Head", "Budget"], ["Salaries", 120000], ["Rent", 48000]] }),
    );

    const { status, body } = await call(`/${row._id}/sheet`, { token: tokenFor() });
    expect(status).toBe(200);
    expect(body.sheets).toHaveLength(1);
    expect(body.sheets[0].name).toBe("Summary");
    expect(body.sheets[0].rows[0]).toEqual(["Head", "Budget"]);
    expect(body.sheets[0].rows[1]).toEqual(["Salaries", "120000"]);
    /* Strings, not numbers: the grid renders what the spreadsheet shows, and
       a value that arrives as a number invites the client to reformat it
       into something the spreadsheet never said. */
    expect(typeof body.sheets[0].rows[1][1]).toBe("string");
    expect(body.sheets[0].truncated).toBe(false);
  });

  test("every sheet in the workbook comes back, so tabs can be drawn", async () => {
    const row = await seedBook();
    servesBytes(
      workbook({
        Summary: [["a"]],
        Detail: [["b"]],
        Notes: [["c"]],
      }),
    );

    const { body } = await call(`/${row._id}/sheet`, { token: tokenFor() });
    expect(body.sheets.map((sh) => sh.name)).toEqual(["Summary", "Detail", "Notes"]);
  });

  test("a big sheet is capped, and says how big it really is", async () => {
    const row = await seedBook();
    const rows = Array.from({ length: 400 }, (_, i) => [`row-${i}`, i]);
    servesBytes(workbook({ Ledger: rows }));

    const { body } = await call(`/${row._id}/sheet`, { token: tokenFor() });
    const sheet = body.sheets[0];

    expect(sheet.rows).toHaveLength(100);
    /* The real size travels with the capped data, which is what lets the
       viewer caption it honestly instead of implying this is all of it. */
    expect(sheet.totalRows).toBe(400);
    expect(sheet.truncated).toBe(true);
    expect(body.limits.rows).toBe(100);
  });

  test("a wide sheet is capped by column too", async () => {
    const row = await seedBook();
    const wide = [Array.from({ length: 80 }, (_, i) => `c${i}`)];
    servesBytes(workbook({ Wide: wide }));

    const { body } = await call(`/${row._id}/sheet`, { token: tokenFor() });
    expect(body.sheets[0].rows[0]).toHaveLength(30);
    expect(body.sheets[0].totalCols).toBe(80);
    expect(body.sheets[0].truncated).toBe(true);
  });

  test("an empty sheet is an empty grid, not an error", async () => {
    const row = await seedBook();
    servesBytes(workbook({ Blank: [] }));

    const { status, body } = await call(`/${row._id}/sheet`, { token: tokenFor() });
    expect(status).toBe(200);
    expect(body.sheets[0].rows).toEqual([]);
    expect(body.sheets[0].totalRows).toBe(0);
  });

  test("a CSV goes through the same endpoint and the same grid", async () => {
    const row = await seedBook({ name: "Ledger.csv", mimeType: "text/csv" });
    servesBytes(Buffer.from('Date,Party,Amount\n2026-08-01,"Acme, Inc.",1200\n'));

    const { status, body } = await call(`/${row._id}/sheet`, { token: tokenFor() });
    expect(status).toBe(200);
    /* The quoted comma is the case a naive split gets wrong, and gets wrong
       silently — every column after it shifts by one. */
    expect(body.sheets[0].rows[1]).toEqual(["2026-08-01", "Acme, Inc.", "1200"]);
  });

  test("a malformed workbook is a clean refusal, not a stack trace", async () => {
    const row = await seedBook();
    servesBytes(Buffer.from("this is definitely not a spreadsheet"));

    const { status, body } = await call(`/${row._id}/sheet`, { token: tokenFor() });
    expect([415, 422]).toContain(status);
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/could not be read|not really a spreadsheet|no sheets/i);
  });

  test("a document that is not a spreadsheet is refused", async () => {
    const row = await seedFile({ name: "Contract.pdf", mimeType: "application/pdf" });
    const { status, body } = await call(`/${row._id}/sheet`, { token: tokenFor() });
    expect(status).toBe(415);
    expect(body.previewKind).toBe("pdf");
  });

  test("a workbook too large to parse is refused with a way forward", async () => {
    const row = await seedBook({ bytes: 20 * 1024 * 1024 });
    const { status, body } = await call(`/${row._id}/sheet`, { token: tokenFor() });
    /* Refused on the recorded size before a byte is fetched — parsing needs
       the whole file in memory, unlike the streamed text preview. */
    expect(status).toBe(413);
    expect(body.message).toMatch(/download it/i);
  });

  test("the same gate as everything else: no session, restricted, trashed", async () => {
    const open = await seedBook();
    expect((await call(`/${open._id}/sheet`)).status).toBe(401);

    const owner = new mongoose.Types.ObjectId();
    const locked = await seedBook({ restricted: true, ownerId: owner });
    expect((await call(`/${locked._id}/sheet`, { token: tokenFor() })).status).toBe(403);

    servesBytes(workbook({ S: [["ok"]] }));
    expect(
      (await call(`/${locked._id}/sheet`, { token: tokenFor({ id: String(owner) }) })).status,
    ).toBe(200);

    const binned = await seedBook({ trashed: true });
    expect((await call(`/${binned._id}/sheet`, { token: tokenFor() })).status).toBe(404);
  });

  test("a workbook is never answered with a provider URL", async () => {
    const row = await seedBook();
    servesBytes(workbook({ S: [["ok"]] }));
    const { body } = await call(`/${row._id}/sheet`, { token: tokenFor() });
    expect(JSON.stringify(body)).not.toMatch(/googleapis|drive\.google|drive-abc/);
  });
});
