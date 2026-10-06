# tydle mp3 deck

Local web frontend: paste a YouTube (`youtube.com` / `youtu.be`) link, preview
the video, download the highest-quality mp3. Links with a `list=` parameter
(regular playlists and RD radio mixes) offer sequential download of every
track, with per-track progress; your browser will ask once to allow multiple
downloads.

## Requirements

- The wasm package built at `../pkg` (`wasm-pack build --target nodejs --out-name tydle --scope wvlen --out-dir pkg --release --no-default-features --features cipher`)
- `ffmpeg` on PATH
- Node 18+
- For the hosted app: yt-dlp 2026.08.19 or newer and Node 22+ for its JavaScript
  runtime. Set `YT_DLP_PATH` to the executable. This avoids the older WASM
  extractor's ANDROID_VR media URLs, which YouTube can reject with HTTP 403
  ([upstream issue](https://github.com/yt-dlp/yt-dlp/issues/17456)).

## Run

```sh
node server.js        # http://localhost:3311  (PORT env var to change)
# Recommended extraction backend:
YT_DLP_PATH=/absolute/path/to/yt-dlp node server.js
```

## How it works

`server.js` (zero npm dependencies) uses `TydleClient` from the wasm build to
extract streams, picks the highest-bitrate audio-only stream (preferring
webm/opus, which ffmpeg demuxes reliably from a pipe), and pipes it through
`ffmpeg -c:a libmp3lame -q:a 0` (~245 kbps VBR) straight to the browser with
title/artist ID3 tags set.

When `YT_DLP_PATH` is set, a yt-dlp subprocess selects the best direct HTTP audio
stream and returns metadata instead. The Node server still fetches the source
in checked ranges and streams ffmpeg's MP3 output. Extractor HTTP headers are
preserved. Configuration files are ignored, requests select one video, and
extraction has a 45-second deadline. Disconnecting a download cancels extraction.
Failures before any MP3 output return a readable JSON error; failures after
streaming begins abort the response so the browser cannot save a partial file.

The hosted service sets `YT_DLP_PATH` in a systemd user-service drop-in. After
changing the executable path, run `systemctl --user daemon-reload` and restart
`tydle-deck.service`. Keep the previous executable available for rollback.

See [the architecture diagrams](architecture.md) for the current deployment
and the proposed Tor/Veilid design.

Calls into the wasm client are serialized through a queue: concurrent calls on
one `TydleClient` panic the wasm module (std Mutex held across an await —
"cannot recursively acquire mutex" on wasm's single thread).

The source is fetched in 10 MiB Range chunks: googlevideo paces unranged
downloads to ~2x the media bitrate (a 53-minute file would take ~25 minutes),
while ranged requests are served at full speed. Progress is streamed to the
page against an estimated output size (duration x ~245 kbps). Because the mp3
is piped, it can't get a Xing VBR header; an exact ID3 `TLEN` tag is written
so players show the right duration.

Progress stays below 100% while that estimated stream is active and changes to
100% only after the browser receives the end of the response. Each source byte
range is checked for completeness, and the HTTP response is completed only
after ffmpeg exits successfully, so a failed transcode is not saved as a
partial MP3. The browser also keeps the generated Blob URL alive long enough
for mobile download managers to consume it.

Playlists are enumerated from YouTube page data (`ytInitialData`), not tydle:
`/playlist` for regular lists, the watch page's playlist panel for RD mixes.

## Network model

A reverse SSH tunnel only carries incoming browser requests to this server.
YouTube extraction and media fetching still run here, so YouTube sees this
server's public IP, not the visitor's IP. Using each visitor's IP requires a
client-side or locally installed extractor/transcoder; forwarding an
`X-Forwarded-For` header can preserve an address for logging or rate limiting,
but cannot change the source IP of this server's outbound requests.

## Verify download completion

```sh
node mp3-frontend/download.test.js  # from the repository root; no wasm build needed
```

The tests cover estimated versus completed progress, response completion after
ffmpeg exits, truncated sources, inconsistent byte ranges, client disconnects,
and delayed Blob URL cleanup. They use local fixtures rather than YouTube.
