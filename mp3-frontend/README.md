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

## Run

```sh
node server.js        # http://localhost:3311  (PORT env var to change)
```

## How it works

`server.js` (zero npm dependencies) uses `TydleClient` from the wasm build to
extract streams, picks the highest-bitrate audio-only stream (preferring
webm/opus, which ffmpeg demuxes reliably from a pipe), and pipes it through
`ffmpeg -c:a libmp3lame -q:a 0` (~245 kbps VBR) straight to the browser with
title/artist ID3 tags set.

Calls into the wasm client are serialized through a queue: concurrent calls on
one `TydleClient` panic the wasm module (std Mutex held across an await —
"cannot recursively acquire mutex" on wasm's single thread).

The source is fetched in 10 MiB Range chunks: googlevideo paces unranged
downloads to ~2x the media bitrate (a 53-minute file would take ~25 minutes),
while ranged requests are served at full speed. Progress is streamed to the
page against an estimated output size (duration x ~245 kbps). Because the mp3
is piped, it can't get a Xing VBR header; an exact ID3 `TLEN` tag is written
so players show the right duration.

Playlists are enumerated from YouTube page data (`ytInitialData`), not tydle:
`/playlist` for regular lists, the watch page's playlist panel for RD mixes.
