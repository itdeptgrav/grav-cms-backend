# Decision: GRAV Music runs as a same-origin CMS surface

**Status:** Accepted for MVP  
**Date:** 10 October 2026

## Decision

The mobile music experience lives at the existing CMS route `/music`. The current GRAV iOS shell already permits `cms.grav.in` and `api.grav.in`, so this route works in its WebView without embedding the Nuclear desktop application or rebuilding the IPA for the first slice.

The browser player is a small GRAV-owned playback surface. It follows Nuclear's two-provider separation: a music metadata catalogue supplies songs and `yt-dlp` remains the server-side playback resolver. For this MVP, browser search uses YouTube Music's songs-only search rather than copying Nuclear's installed AGPL Spotify plugin or exposing generic YouTube results. The Nuclear desktop bridge remains the desktop implementation and is selected only when `window.gravDesktop` exists.

## Why

- Tauri/Nuclear desktop code and binaries cannot run inside an iOS or Android WebView.
- A same-origin CMS route fits the existing mobile allowlist and authentication flow.
- Keeping process execution on the backend prevents a browser from becoming a general-purpose downloader or command runner.
- One route gives desktop, browser, iOS, and a future Android wrapper a consistent GRAV entry point while allowing different playback adapters.

## Consequences

- The backend deployment owns `yt-dlp` availability and updates.
- Signed GRAV playback URLs are temporary and must be resolved again when stale. GRAV proxies the provider stream so resolution and playback use the same network identity.
- Playback availability remains dependent on the source provider and network conditions.
- Streaming consumes GRAV backend bandwidth, so production must size and rate-limit this path before a broad release.
