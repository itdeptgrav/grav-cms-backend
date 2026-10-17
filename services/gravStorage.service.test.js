"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const storage = require("./gravStorage.service");

test("uploads a binary asset with server credentials and preserves storage metadata", async () => {
  const previous = {
    url: process.env.GRAV_STORAGE_URL,
    key: process.env.GRAV_STORAGE_API_KEY,
    fetch: global.fetch,
  };
  process.env.GRAV_STORAGE_URL = "https://storage.example";
  process.env.GRAV_STORAGE_API_KEY = "test-server-key";

  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ file: { fileId: "stored-123", size: 3, sha256: "server-sha" } }), { status: 201 });
  };

  try {
    const result = await storage.uploadBuffer(Buffer.from("abc"), { fileName: "front.png", mimeType: "image/png" });
    assert.equal(request.url, "https://storage.example/api/v1/files");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers.Authorization, "Bearer test-server-key");
    assert.equal(result.storageFileId, "stored-123");
    assert.equal(result.fileName, "front.png");
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.bytes, 3);
    assert.equal(result.sha256, "server-sha");
  } finally {
    if (previous.url === undefined) delete process.env.GRAV_STORAGE_URL; else process.env.GRAV_STORAGE_URL = previous.url;
    if (previous.key === undefined) delete process.env.GRAV_STORAGE_API_KEY; else process.env.GRAV_STORAGE_API_KEY = previous.key;
    global.fetch = previous.fetch;
  }
});

test("refuses uploads when private storage credentials are missing", async () => {
  const previous = { url: process.env.GRAV_STORAGE_URL, key: process.env.GRAV_STORAGE_API_KEY };
  delete process.env.GRAV_STORAGE_URL;
  delete process.env.GRAV_STORAGE_API_KEY;
  try {
    await assert.rejects(
      storage.uploadBuffer(Buffer.from("abc"), { fileName: "front.png", mimeType: "image/png" }),
      { code: "GRAV_STORAGE_UNAVAILABLE" },
    );
  } finally {
    if (previous.url === undefined) delete process.env.GRAV_STORAGE_URL; else process.env.GRAV_STORAGE_URL = previous.url;
    if (previous.key === undefined) delete process.env.GRAV_STORAGE_API_KEY; else process.env.GRAV_STORAGE_API_KEY = previous.key;
  }
});
