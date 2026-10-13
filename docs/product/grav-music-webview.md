# GRAV Music WebView MVP

## Product outcome

An authenticated CMS user can open `/music` inside the existing GRAV iOS WebView, search for music, play a result, maintain a queue, seek, change volume, and keep local favourites. Playback exposes browser media-session metadata and play/pause/previous/next actions where the operating system supports them.

The existing desktop integration remains unchanged: a GRAV desktop session continues to control its bundled Nuclear player. A browser, iPhone, or Android WebView uses the web player instead.

## MVP flow

1. The CMS detects whether the desktop bridge exists.
2. Browser/WebView sessions show the web player.
3. The signed-in browser sends an authenticated search to `GET /api/cms/music/search`.
4. The backend searches YouTube Music with its songs-only filter and returns normalized track metadata. Generic YouTube videos, podcasts, albums, artists, and playlists are not returned as tracks.
5. When a user selects a track, the browser sends only its validated YouTube Music video id to `POST /api/cms/music/resolve`.
6. The backend uses `yt-dlp` to select an audio-only format and returns a short-lived signed GRAV stream URL.
7. GRAV resolves and proxies the provider bytes from the same server network identity, including byte ranges for seeking.
8. The browser plays that URL with `HTMLAudioElement` and integrates with the operating-system media controls.

## Security boundary

- Every CMS music endpoint requires the existing employee session.
- The browser cannot supply a command, executable path, arbitrary source URL, format expression, or callback URL.
- Video ids must match the eleven-character YouTube id format.
- Search text and result limits are bounded.
- `yt-dlp` runs through `execFile`, never a shell.
- Provider media URLs never reach the browser. Signed GRAV stream URLs expire after ten minutes and are marked private/no-store.
- Local favourites stay in that browser's storage for this MVP.

## Runtime

Development may use the ignored `.local-tools/yt-dlp-venv`, whose pinned packages are listed in `scripts/music/requirements.txt`. Deployed environments must install and update `yt-dlp`, `ytmusicapi`, and the certificate bundle independently. `YTDLP_PATH` and `YTMUSIC_PYTHON_PATH` can point at those runtimes.

## Release boundary

The MVP proves the product and technical flow. Public or employee-wide release still requires a review of source-provider terms, copyright/licensing expectations, mobile background-play behaviour, bandwidth, abuse controls, and the production update procedure for `yt-dlp`.
