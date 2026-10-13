"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createYtDlpPlayer,
  normalizeSearchRow,
  validateVideoId,
} = require("./ytdlpPlayer.service");
const { streamToken, verifyStreamToken } = require("../../routes/music/webPlayer.routes").helpers;

test("normalizes yt-dlp search rows for the CMS player", () => {
  assert.deepEqual(
    normalizeSearchRow({
      id: "dQw4w9WgXcQ",
      title: "A song",
      channel: "An artist",
      duration: 213,
      thumbnails: [{ url: "small", width: 120 }, { url: "large", width: 640 }],
    }),
    {
      id: "dQw4w9WgXcQ",
      title: "A song",
      artist: "An artist",
      durationSeconds: 213,
      artworkUrl: "large",
    },
  );
});

test("accepts only a YouTube video id", () => {
  assert.equal(validateVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.throws(() => validateVideoId("https://example.com/song"), /video id/i);
  assert.throws(() => validateVideoId("$(touch bad)"), /video id/i);
});

test("search uses argument arrays and parses newline-delimited JSON", async () => {
  const calls = [];
  const player = createYtDlpPlayer({
    binary: "/opt/yt-dlp",
    run: async (binary, args) => {
      calls.push({ binary, args });
      return [
        JSON.stringify({ id: "dQw4w9WgXcQ", title: "One", channel: "Artist", duration: 100 }),
        JSON.stringify({ id: "M7lc1UVf-VE", title: "Two", uploader: "Singer", duration: 200 }),
      ].join("\n");
    },
  });

  const tracks = await player.search("odia songs", { limit: 2 });
  assert.equal(tracks.length, 2);
  assert.equal(calls[0].binary, "/opt/yt-dlp");
  assert.deepEqual(calls[0].args.slice(-1), ["ytsearch2:odia songs"]);
  assert.equal(calls[0].args.includes("--dump-json"), true);
});

test("resolve returns only the selected audio stream metadata", async () => {
  const player = createYtDlpPlayer({
    run: async () => JSON.stringify({
      id: "dQw4w9WgXcQ",
      title: "One",
      channel: "Artist",
      duration: 100,
      url: "https://rr.example.googlevideo.com/audio",
      ext: "m4a",
      acodec: "mp4a.40.2",
    }),
  });

  const result = await player.resolve("dQw4w9WgXcQ");
  assert.equal(result.streamUrl, "https://rr.example.googlevideo.com/audio");
  assert.equal(result.contentType, "audio/mp4");
  assert.equal(result.track.id, "dQw4w9WgXcQ");
});

test("playback tokens are short-lived and bound to one video", () => {
  const token = streamToken("dQw4w9WgXcQ", "employee-1");
  assert.equal(verifyStreamToken(token, "dQw4w9WgXcQ").purpose, "cms-music-stream");
  assert.throws(() => verifyStreamToken(token, "M7lc1UVf-VE"), /stream token/i);
});
