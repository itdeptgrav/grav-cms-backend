// test/maintenance/maintenance-files.route.test.js
//
// PHOTOS AND DOCUMENTS of Maintenance jobs: uploaded through the backend to
// Google Drive PRIVATELY, read back only through the signed-in route, and only
// when a job holds the file. Google Drive itself is replaced by an in-memory
// stand-in here — these tests never reach the real Drive.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);



/* The stand-in for services/maintenance/maintenanceDrive's Drive calls. */
const mockStored = new Map();
const mockDrive = { configured: true };
jest.mock("../../services/maintenance/maintenanceDrive", () => {
  const real = jest.requireActual("../../services/maintenance/maintenanceDrive");
  return {
    ...real,
    uploadFile: jest.fn(async (buffer, { name, mimeType }) => {
      if (!mockDrive.configured) throw new real.DriveNotConfigured("Google Drive is not configured on the server (GOOGLE_SERVICE_ACCOUNT_KEY).");
      const fileId = `1Drive${String(mockStored.size + 1).padStart(12, "0")}`;
      mockStored.set(fileId, { buffer: Buffer.from(buffer), name, mimeType });
      return { fileId, name, mimeType, size: buffer.length };
    }),
    streamFile: jest.fn(async (fileId) => {
      const f = mockStored.get(fileId);
      return { stream: require("stream").Readable.from([f.buffer]), meta: { name: f.name, mimeType: f.mimeType, size: f.buffer.length } };
    }),
  };
});

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Employee = require("../../models/Employee");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const MaintenanceOrder = require("../../models/CMS_Models/Maintenance/MaintenanceOrder");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const storage = require("../../services/maintenance/maintenanceStorage");
const drive = require("../../services/maintenance/maintenanceDrive");

let http, base, seq = 0;
const ROOT = "/api/cms/maintenance";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms", EmployeeAuthMiddleware, (req, res, next) => next());
  app.use(ROOT, require("../../routes/CMS_Routes/Maintenance/maintenanceRoutes"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}${ROOT}`;
});
afterAll(async () => { await new Promise((r) => http.close(r)); });
beforeEach(async () => {
  mockStored.clear();
  mockDrive.configured = true;
  storage.resetStorageCache();
  await storage.ensureOrderStorage({ create: true });
});

async function person(grant) {
  const n = ++seq;
  const email = `mf${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({ firstName: "Tech", lastName: `F${n}`, email, biometricId: `MF${n}${Date.now() % 100000}`,
    isActive: true, gender: "Other", department: "Maintenance", designation: "Technician" });
  if (grant) await DepartmentRole.create({ departmentSlug: "maintenance", email, name: "Tech", role: grant, isActive: true, departmentId: new mongoose.Types.ObjectId() });
  return jwt.sign({ id: String(emp._id), email, name: `Tech F${n}`, role: "maintenance", deptSlug: "maintenance" }, process.env.JWT_SECRET, { expiresIn: "10m" });
}

function uploadForm(name, type, bytes) {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type }), name);
  return fd;
}
const send = (token, fd) => fetch(`${base}/files`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const get = (token, id, q = "") => fetch(`${base}/files/${id}${q}`, { headers: { Authorization: `Bearer ${token}` } });
const createJob = (token, attachments) => fetch(`${base}/orders`, {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ orderType: "service", service: { name: "Lift" }, attachments, idempotencyKey: `files-${Date.now()}-${Math.random()}` }),
}).then((r) => r.json());

describe("uploading photos and documents", () => {
  test("a photo and a PDF go to Drive privately; the answer is the reference a job keeps", async () => {
    const tech = await person("editor");
    const photo = await send(tech, uploadForm("fault photo.jpg", "image/jpeg", new Uint8Array(2048)));
    expect(photo.status).toBe(201);
    expect(photo.body.file).toMatchObject({ name: "fault photo.jpg", mimeType: "image/jpeg", size: 2048 });
    const pdf = await send(tech, uploadForm("vendor quote.pdf", "application/pdf", new Uint8Array(4096)));
    expect(pdf.status).toBe(201);
    const job = await createJob(tech, [photo.body.file, pdf.body.file]);
    expect(job.order.attachments.map((a) => a.name)).toEqual(["fault photo.jpg", "vendor quote.pdf"]);
    expect(drive.uploadFile).toHaveBeenCalled();
  });

  test("a non-English file name survives", async () => {
    const tech = await person("editor");
    const r = await send(tech, uploadForm("मशीन फोटो.png", "image/png", new Uint8Array(10)));
    expect(r.status).toBe(201);
    expect(r.body.file.name).toBe("मशीन फोटो.png");
  });

  test("refused in words: program files, empty files, over 25 MB, no file", async () => {
    const tech = await person("editor");
    expect((await send(tech, uploadForm("setup.exe", "application/octet-stream", new Uint8Array(10)))).body.message).toBe("setup.exe is a program file and cannot be attached.");
    expect((await send(tech, uploadForm("empty.txt", "text/plain", new Uint8Array(0)))).body.message).toBe("empty.txt is empty.");
    const big = await send(tech, uploadForm("huge.pdf", "application/pdf", new Uint8Array(drive.MAX_BYTES + 1)));
    expect(big.status).toBe(413);
    expect(big.body.message).toBe("That file is over 25 MB. Attach a smaller copy.");
    expect((await send(tech, new FormData())).status).toBe(400);
    expect(mockStored.size).toBe(0);
  });

  test("a viewer cannot upload; Drive not configured is said plainly", async () => {
    const viewer = await person("viewer");
    expect((await send(viewer, uploadForm("a.jpg", "image/jpeg", new Uint8Array(10)))).status).toBe(403);
    const tech = await person("editor");
    mockDrive.configured = false;
    const r = await send(tech, uploadForm("a.jpg", "image/jpeg", new Uint8Array(10)));
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/Google Drive is not configured/);
  });
});

describe("reading them back", () => {
  test("a job's photo streams back inline; a document that could run downloads instead", async () => {
    const tech = await person("editor");
    const photo = (await send(tech, uploadForm("fault.jpg", "image/jpeg", Buffer.from("JPEGBYTES")))).body.file;
    const page = (await send(tech, uploadForm("notes.html", "text/html", Buffer.from("<script>alert(1)</script>")))).body.file;
    await createJob(tech, [photo, page]);
    const viewer = await person("viewer");
    const r = await get(viewer, photo.fileId);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("content-disposition")).toMatch(/^inline/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("JPEGBYTES");
    const h = await get(viewer, page.fileId);
    expect(h.headers.get("content-disposition")).toMatch(/^attachment/);
    expect((await get(viewer, photo.fileId, "?dl=1")).headers.get("content-disposition")).toMatch(/^attachment/);
  });

  test("a file no job holds is never served — not even one just uploaded", async () => {
    const tech = await person("editor");
    const loose = (await send(tech, uploadForm("loose.jpg", "image/jpeg", new Uint8Array(10)))).body.file;
    expect((await get(tech, loose.fileId)).status).toBe(404);
    expect((await get(tech, "not-a-drive-id!")).status).toBe(404);
  });

  test("another department cannot read a job's file", async () => {
    const tech = await person("editor");
    const photo = (await send(tech, uploadForm("fault.jpg", "image/jpeg", new Uint8Array(10)))).body.file;
    await createJob(tech, [photo]);
    const stranger = jwt.sign({ id: String(new mongoose.Types.ObjectId()), name: "Store", role: "store", deptSlug: "store" }, process.env.JWT_SECRET, { expiresIn: "5m" });
    expect((await get(stranger, photo.fileId)).status).toBe(403);
    expect(await MaintenanceOrder.countDocuments()).toBe(1);
  });
});
