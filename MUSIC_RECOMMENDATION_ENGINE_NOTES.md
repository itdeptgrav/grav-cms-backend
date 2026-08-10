# Music Recommendation Engine — Implementation Note

Phase-0 inspection result and the plan that follows from it. Written before any
code changed. Scope of this note: **Stage 1 (Foundation)** per the spec's own
implementation order. Stages 2–4 (personalization, embeddings, collaborative)
are designed-for but not built yet.

## Current architecture (what exists today)

**Two repos, and the music feature lives entirely in the frontend.**

- **Frontend** — `/Users/risheeray/Desktop/Cowork` (Next.js App Router, TS,
  branch `RISHEE_COWORK`, package `nodeinit`). The whole "Focus Music / Cowork
  Autoplay" feature is here:
  - Player: `components/features/music/` (`PlayerEngine`, `MusicBar`,
    `MusicArea`, `MusicContext`) + `lib/music/useYouTubePlayer.ts` (official
    YouTube IFrame API, one shell-mounted iframe).
  - YouTube data: **Next.js API routes** `app/api/music/search|video/route.ts`
    → `lib/music/youtube.ts` (`YouTubeMusicProvider`, `search.list` +
    `videos.list`, in-memory TTL cache, quota guard). Key is server-only
    `YOUTUBE_API_KEY`; public flag `NEXT_PUBLIC_ENABLE_YOUTUBE_MUSIC`.
  - Autoplay brain: `lib/music/autoplay.ts` (`pickLocally`, `autoplayQuery`) —
    **history-based, explicitly NOT a YouTube related-feed** (the old
    `relatedToVideoId` API was removed Aug 2023). This is the seam we replace.
  - Autoplay decision point: `MusicContext.tsx` `next()`.
  - User music state (queue, favourites, playlists, prefs, recent): **localStorage**
    via `getRepository()` → `lib/repositories/mock/musicStore.ts`. No server
    persistence today.
  - Backend-call path already present: `lib/legacy/http.ts` (`legacyFetch`) →
    `NEXT_PUBLIC_LEGACY_API_URL`, Firebase ID token → backend `verifyCoworkToken`.

- **Backend** — `grav-cms-backend` (Express + Mongoose 8 + MongoDB Atlas,
  Firebase auth for Cowork). **Zero music/YouTube code today** — it is a
  garment-manufacturing ERP. No YouTube key, no media models, no vector search.
  Reusable pieces: route-mount pattern in `server.js` (`app.use("/prefix", …)`),
  `services/*.service.js` convention, cowork auth (`Middlewear/coworkAuth.js` →
  `req.coworkUser.employeeId`), axios, jest. AI infra present for later stages:
  Gemini (`@google/genai`, `GEMINI_API_KEY`) and Ollama (`services/ollamaClient.js`).

## Decision (confirmed with the user)

The recommendation engine and its persistence live in **grav-cms-backend**. The
frontend calls it over the existing Firebase-authed path and wires the UI.
YouTube candidate generation moves server-side (backend gets its own
`YOUTUBE_API_KEY`), which also centralizes quota control per the spec.

Per-user key: **`req.coworkUser.employeeId`** string (e.g. `"E014"`), which is
also the Mongo `Employee.biometricId`. No Firestore↔Mongo join needed.

## Stage 1 — files created (backend)

```
config/... (inline)         services/music/recommendation.config.js   weights, thresholds, TTLs, flags — all magic numbers centralized
models/music/VideoMetadata.js          cached YouTube metadata, keyed by videoId, TTL via fetchedAt
models/music/UserVideoInteraction.js   one doc per (userId, videoId), accumulates watch/like/skip signals
services/music/text.util.js            tokenization + lexical similarity (cosine/Jaccard) — no LLM
services/music/embedding.service.js    embeddingProvider interface; Stage-1 no-op (returns null) so ranking degrades gracefully
services/music/youtube.service.js      central YouTube Data API client: search()/videoDetails(), in-mem TTL cache + quota guard
services/music/metadata.service.js     get-or-fetch metadata with Mongo cache + TTL; batches videos.list
services/music/candidates.service.js   derive search concepts from a seed video, run several searches, dedupe → 50–200 pool
services/music/interaction.service.js  record checkpoints (upsert), read a user's interactions / watched ids
services/music/ranking.service.js      weighted V1 scoring → normalized score + per-signal reasons (debug-gated)
services/music/recommendation.service.js  orchestrator: getNextVideo / getSuggestedVideos, hard filters, loop prevention, fallbacks
routes/music/recommendations.routes.js    REST endpoints (cowork-authed)
services/music/__tests__/*.test.js     jest: dedup, current-exclusion, watched penalty, creator boost, completion boost, skip penalty, normalization, diversity, cold start, fallback, loop prevention
```

`server.js`: one added mount line — `app.use("/cowork/music", require("./routes/music/recommendations.routes"))`.

## API changes (new endpoints, all under `/cowork/music`, cowork-authed)

- `GET  /recommendations/next?videoId=&sessionId=&exclude=id,id` → `{ next: {videoId,title,thumbnail,channelTitle,score} | null }`
- `GET  /recommendations/videos/:videoId?limit=&exclude=` → `{ currentVideoId, recommendations: [...] }`
- `GET  /recommendations/home?limit=` → `{ recommendations: [...] }` (Stage-1: popular/interest-lite; full personalization is Stage 2)
- `POST /interactions` body `{ videoId, channelId?, event, watchedSeconds?, durationSeconds?, clickedFromRecommendation?, searchQuery?, sessionId? }`
  where `event ∈ {started,progress,ended,skipped,liked,disliked,replayed,recommendation_click}`

## Schema changes

Two new collections (`videometadatas`, `uservideointeractions`), indexed on
`videoId` (unique) and `{userId, videoId}` (unique) + `{userId, lastWatchedAt}`,
`{userId, channelId}`. No existing schema touched. Bounded growth: interactions
are one-per-(user,video), not per-play-event.

## Frontend changes (Desktop/Cowork)

- `lib/music/recommendationClient.ts` — thin wrapper over `legacyFetch` for the
  new endpoints + interaction posts. Fails soft (never throws into playback).
- `lib/music/interactionTracker.ts` — computes completion-crossing checkpoints
  (10/25/50/75/90/ended/skipped) from player snapshots; batched, not per-second.
- `MusicContext.tsx` `next()` — try backend `/next` first when autoplay is on;
  fall back to existing `pickLocally`/`autoplayQuery` on any failure. Prefetch
  at ~50–70% for instant end-of-track handoff.
- Minimal "Up next" affordance reusing the existing `autoplayNotice` line; a
  fuller countdown UI + suggested-list panel are incremental additions.

## Dependencies added

**None** in Stage 1. Backend uses existing `axios`; similarity is hand-rolled
(no LLM, no vector store yet). Embeddings/vector search are Stage 3 behind a
flag.

## Env vars added (backend)

```
YOUTUBE_API_KEY=                          # server-side key for candidate generation
RECOMMENDATION_ENGINE_ENABLED=true
RECOMMENDATION_EMBEDDINGS_ENABLED=false   # Stage 3
RECOMMENDATION_COLLABORATIVE_ENABLED=false# Stage 4
RECOMMENDATION_DEBUG=false                # expose per-signal reasons + verbose logs
```

## Assumptions

1. "cowork-ios" = `/Users/risheeray/Desktop/Cowork` (confirmed).
2. Backend owns recs + persistence (confirmed).
3. One `YOUTUBE_API_KEY` (may equal the frontend's value) is acceptable for now;
   quota is shared at the Google-project level.
4. Interaction identity is `employeeId` string; the same person on any device
   accrues one profile.
5. Stage 1 ranking uses lexical similarity only; embeddings/collaborative are
   later stages and must not block Stage 1.
```
