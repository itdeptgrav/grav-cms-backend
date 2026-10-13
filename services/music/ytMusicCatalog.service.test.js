"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createYtMusicCatalog, normalizeSong } = require("./ytMusicCatalog.service");

test("normalizes only a YouTube Music song", () => {
  assert.deepEqual(normalizeSong({
    resultType: "song",
    videoId: "dQw4w9WgXcQ",
    title: "Ghost",
    artists: [{ name: "Justin Bieber" }],
    album: { name: "Justice" },
    duration_seconds: 153,
    thumbnails: [{ url: "small", width: 60 }, { url: "large", width: 544 }],
  }), {
    id: "dQw4w9WgXcQ",
    title: "Ghost",
    artist: "Justin Bieber",
    album: "Justice",
    durationSeconds: 153,
    artworkUrl: "large",
  });
  assert.equal(normalizeSong({ resultType: "video", videoId: "dQw4w9WgXcQ" }), null);
});

test("catalog invokes the songs-only helper and rejects malformed rows", async () => {
  const calls = [];
  const catalog = createYtMusicCatalog({
    python: "/opt/python",
    script: "/app/search.py",
    run: async (binary, args) => {
      calls.push({ binary, args });
      return JSON.stringify([
        { resultType: "song", videoId: "dQw4w9WgXcQ", title: "Ghost", artists: [{ name: "Artist" }] },
        { resultType: "video", videoId: "M7lc1UVf-VE", title: "A video" },
      ]);
    },
  });
  const rows = await catalog.search("ghost", { limit: 10 });
  assert.equal(rows.length, 1);
  assert.deepEqual(calls[0], { binary: "/opt/python", args: ["/app/search.py", "ghost", "10"] });
});
