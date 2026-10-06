// Local frontend for tydle: paste a YouTube URL, get the best audio stream
// transcoded to mp3 (ffmpeg -q:a 0). Zero npm dependencies; uses the wasm
// build in ../pkg and the system ffmpeg.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { once } = require("node:events");
const { TydleClient } = require("../pkg/tydle.js");

const PORT = process.env.PORT || 3311;
const HOST = process.env.HOST || "127.0.0.1";
// Set this to a current yt-dlp executable to use maintained YouTube clients.
// Older tydle builds select ANDROID_VR URLs that can reject later media bytes.
const YT_DLP_PATH = process.env.YT_DLP_PATH;
// Legacy WASM extraction can optionally use a bgutil PO-token provider.
// This setting applies only when YT_DLP_PATH is unset; prefer the maintained
// extractor for current YouTube client support.
const client = new TydleClient({
  poTokenProviderUrl: process.env.POT_PROVIDER_URL || "",
});

const ID_PATTERNS = [
  /youtu\.be\/([A-Za-z0-9_-]{11})/,
  /youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/,
  /^([A-Za-z0-9_-]{11})$/,
];

function parseVideoId(input) {
  const trimmed = input.trim();
  for (const re of ID_PATTERNS) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  return null;
}

// Best audio-only stream with a directly usable URL. webm/opus is preferred
// over m4a because ffmpeg demuxes it reliably from a pipe (mp4 may have its
// moov atom at the end).
function pickBestAudio(streams) {
  return streams
    .filter((s) => s.codec.acodec && !s.codec.vcodec && "url" in s.source && !s.hasDrm)
    .sort((a, b) => (b.ext === "webm") - (a.ext === "webm") || b.tbr - a.tbr)[0];
}

// The wasm TydleClient panics on concurrent calls (RefCell re-entrancy), so
// every use of it is serialized through this queue.
let clientQueue = Promise.resolve();
function withClient(fn) {
  const job = clientQueue.then(fn);
  clientQueue = job.catch(() => {});
  return job;
}

async function extractWithYtDlp(videoId, signal) {
  const output = await new Promise((resolve, reject) => {
    execFile(YT_DLP_PATH, [
      "--ignore-config", "--no-playlist", "--no-warnings",
      "--js-runtimes", `node:${process.execPath}`,
      "--socket-timeout", "15", "--retries", "1", "--extractor-retries", "1",
      "--format", "bestaudio[protocol=https]/bestaudio[protocol=http]",
      "--dump-single-json", `https://www.youtube.com/watch?v=${videoId}`,
    ], { signal, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        if (signal?.aborted) return reject(signal.reason);
        return reject(new Error(error.code === "ENOENT"
          ? "The YouTube download extractor is unavailable."
          : "YouTube extraction failed. The video may be unavailable; please try again."));
      }
      resolve(stdout);
    });
  });
  const data = JSON.parse(output);
  const url = new URL(data.url);
  if (!["https:", "http:"].includes(url.protocol) || !data.acodec || data.acodec === "none" ||
      (data.vcodec && data.vcodec !== "none")) {
    throw new Error("No downloadable audio stream found for this video.");
  }
  const duration = Number(url.searchParams.get("dur")) || data.duration;
  return {
    info: {
      title: data.title,
      channel: { name: data.channel ?? data.uploader ?? "" },
      duration: data.duration,
      thumbnails: data.thumbnails ?? (data.thumbnail ? [{ url: data.thumbnail }] : []),
    },
    audio: {
      source: { url: data.url, headers: data.http_headers ?? {} },
      codec: { acodec: data.acodec },
      ext: data.ext,
      fileSize: data.filesize,
      tbr: (data.abr ?? data.tbr ?? 0) * 1000,
      formatDuration: duration * 1000,
    },
  };
}

function extract(videoId, signal) {
  if (YT_DLP_PATH) return extractWithYtDlp(videoId, signal);
  return withClient(async () => {
    const info = await client.fetchVideoInfo(videoId);
    const { streams } = await client.fetchStreams(videoId);
    const audio = pickBestAudio(streams);
    if (!audio) throw new Error("No downloadable audio stream found for this video.");
    return { info, audio };
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").replace(/\s+/g, " ").trim() || "audio";
}

async function handleInfo(res, videoId) {
  const { info, audio } = await extract(videoId);
  const thumbnail = info.thumbnails.at(-1)?.url ?? null;
  sendJson(res, 200, {
    videoId,
    title: info.title,
    channel: info.channel.name,
    duration: info.duration,
    thumbnail,
    source: { ext: audio.ext, codec: audio.codec.acodec, kbps: Math.round(audio.tbr / 1000) },
  });
}

// googlevideo paces unranged downloads to ~2x the media bitrate (a 53-minute
// file would take ~25 minutes), but Range requests are served at full speed —
// so fetch the source in 10 MiB chunks.
const CHUNK_SIZE = 10 * 1024 * 1024;

async function pipeSourceToFfmpeg(audio, dest, signal) {
  const write = async (body) => {
    if (!body) throw new Error("YouTube returned an empty response body.");
    let bytes = 0;
    for await (const chunk of body) {
      bytes += chunk.length;
      if (!dest.write(chunk)) await once(dest, "drain", { signal });
    }
    return bytes;
  };

  let sourceSize = Number(audio.fileSize);
  if (Number.isSafeInteger(sourceSize) && sourceSize > 0) {
    let start = 0;
    let rangeSize = null;
    while (start < sourceSize) {
      const requestedEnd = Math.min(start + CHUNK_SIZE, sourceSize) - 1;
      const r = await fetch(audio.source.url, {
        headers: { ...audio.source.headers, Range: `bytes=${start}-${requestedEnd}` },
        signal,
      });
      if (!r.ok) throw new Error(`YouTube stream request failed (HTTP ${r.status}).`);

      // Some origins ignore Range and return the complete file. Accept that
      // only for the first request so the source cannot be duplicated.
      if (r.status === 200 && start === 0) {
        const lengthHeader = r.headers.get("Content-Length");
        const contentLength = lengthHeader == null ? sourceSize : Number(lengthHeader);
        const received = await write(r.body);
        if (Number.isSafeInteger(contentLength) && received !== contentLength) {
          throw new Error(`Incomplete YouTube stream (${received} of ${contentLength} bytes).`);
        }
        dest.end();
        return;
      }
      if (r.status !== 206) {
        throw new Error(`YouTube ignored a range request at byte ${start}.`);
      }

      const contentRange = r.headers.get("Content-Range") ?? "";
      const match = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
      if (!match) throw new Error("YouTube returned an invalid ranged stream response.");
      const rangeStart = Number(match[1]);
      const rangeEnd = Number(match[2]);
      const reportedSize = match[3] === "*" ? null : Number(match[3]);
      if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd) ||
          rangeStart !== start || rangeEnd < rangeStart || rangeEnd > requestedEnd) {
        throw new Error(`Unexpected YouTube byte range ${rangeStart}-${rangeEnd}.`);
      }
      if (reportedSize !== null) {
        if (!Number.isSafeInteger(reportedSize) || reportedSize <= rangeEnd ||
            (rangeSize !== null && reportedSize !== rangeSize)) {
          throw new Error("Unexpected YouTube stream size in Content-Range.");
        }
        rangeSize = sourceSize = reportedSize;
      }

      const expected = rangeEnd - rangeStart + 1;
      const received = await write(r.body);
      if (received !== expected) {
        throw new Error(`Incomplete YouTube range (${received} of ${expected} bytes).`);
      }
      start = rangeEnd + 1;
    }
  } else {
    const r = await fetch(audio.source.url, { headers: audio.source.headers, signal });
    if (!r.ok) throw new Error(`YouTube stream request failed (HTTP ${r.status}).`);
    const lengthHeader = r.headers.get("Content-Length");
    const contentLength = lengthHeader == null ? null : Number(lengthHeader);
    const received = await write(r.body);
    if (Number.isSafeInteger(contentLength) && received !== contentLength) {
      throw new Error(`Incomplete YouTube stream (${received} of ${contentLength} bytes).`);
    }
  }
  dest.end();
}

// LAME -q:a 0 averages ~245 kbps; formatDuration is in milliseconds.
function estimateMp3Bytes(audio) {
  return Math.round((audio.formatDuration / 1000) * (245000 / 8));
}

async function handleDownload(res, videoId) {
  const controller = new AbortController();
  let ffmpeg;
  res.on("close", () => {
    if (res.writableEnded) return;
    controller.abort();
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill("SIGKILL");
  });
  const { info, audio } = await extract(videoId, controller.signal);
  controller.signal.throwIfAborted();

  ffmpeg = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-xerror", "-abort_on", "empty_output",
    "-i", "pipe:0",
    "-vn", "-c:a", "libmp3lame", "-q:a", "0",
    "-metadata", `title=${info.title}`,
    "-metadata", `artist=${info.channel.name ?? ""}`,
    // Piped output can't get a Xing VBR header, so players would estimate
    // duration from the average bitrate; TLEN gives them the exact value.
    "-metadata", `TLEN=${Math.round(audio.formatDuration)}`,
    "-id3v2_version", "3",
    "-f", "mp3", "pipe:1",
  ], { stdio: ["pipe", "pipe", "inherit"] });

  const headers = {
    "Content-Type": "audio/mpeg",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(sanitizeFilename(info.title))}.mp3`,
    "X-Estimated-Content-Length": String(estimateMp3Bytes(audio)),
  };

  // Delay the MP3 headers until there is output. Failures before streaming can
  // then return JSON instead of making nginx generate an opaque 502 page.
  ffmpeg.stdout.once("data", () => res.writeHead(200, headers));
  const fail = (err) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) res.destroy(err);
    else sendJson(res, 502, { error: err.message ?? "Download failed." });
  };

  let processError = null;
  let sourceError = null;
  let stdinError = null;

  ffmpeg.on("error", (err) => {
    processError = err;
    controller.abort();
    console.error(err);
    fail(err);
  });
  ffmpeg.stdin.on("error", (err) => {
    stdinError = err;
    controller.abort();
    if (err.code !== "EPIPE") console.error(err);
  });
  ffmpeg.stdout.on("error", (err) => {
    processError ??= err;
    controller.abort();
    console.error(err);
    fail(err);
  });

  // Do not let stdout's end event mark a failed or truncated transcode as a
  // successful HTTP response. Only a clean ffmpeg exit may end the response.
  ffmpeg.stdout.pipe(res, { end: false });
  const source = pipeSourceToFfmpeg(audio, ffmpeg.stdin, controller.signal).catch((err) => {
    sourceError = err;
    controller.abort();
    console.error(err);
    ffmpeg.stdin.destroy();
    if (!ffmpeg.killed) ffmpeg.kill("SIGKILL");
  });

  ffmpeg.on("close", async (code) => {
    controller.abort();
    await source;
    if (code === 0 && !sourceError && !processError && !stdinError) {
      res.end();
      return;
    }
    const err = sourceError ?? processError ?? stdinError ?? new Error(`ffmpeg exited with code ${code}`);
    fail(err);
  });
}

// Playlists aren't part of tydle's API; enumerate them from YouTube's page
// data. Regular playlists resolve via /playlist, radio mixes (RD…) only via
// the watch page's playlist panel.
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "Accept-Language": "en",
};

function walkJson(node, key, out) {
  if (!node || typeof node !== "object") return;
  if (node[key]) out.push(node[key]);
  for (const v of Object.values(node)) walkJson(v, key, out);
  return out;
}

async function fetchInitialData(pageUrl) {
  const res = await fetch(pageUrl, { headers: BROWSER_HEADERS });
  const html = await res.text();
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) throw new Error("Couldn't read playlist data from YouTube.");
  return JSON.parse(m[1]);
}

async function handlePlaylist(res, listId, videoId) {
  let renderers = [];
  let title = null;
  if (!listId.startsWith("RD")) {
    const data = await fetchInitialData(`https://www.youtube.com/playlist?list=${listId}`);
    renderers = walkJson(data, "playlistVideoRenderer", []);
    title = walkJson(data, "playlistHeaderRenderer", [])[0]?.title?.simpleText ?? null;
  }
  if (renderers.length === 0) {
    // Radio mixes (and fallback): use the watch page's playlist panel.
    const v = videoId ? `v=${videoId}&` : "";
    const data = await fetchInitialData(`https://www.youtube.com/watch?${v}list=${listId}`);
    const panel = data?.contents?.twoColumnWatchNextResults?.playlist?.playlist;
    renderers = (panel?.contents ?? []).map((c) => c?.playlistPanelVideoRenderer).filter(Boolean);
    title = panel?.title ?? title;
  }
  const seen = new Set();
  const videos = [];
  for (const r of renderers) {
    if (!r.videoId || seen.has(r.videoId)) continue;
    seen.add(r.videoId);
    videos.push({
      videoId: r.videoId,
      title: r.title?.simpleText ?? r.title?.runs?.map((x) => x.text).join("") ?? r.videoId,
    });
  }
  if (videos.length === 0) throw new Error("Couldn't find any videos in that playlist.");
  sendJson(res, 200, { listId, title, videos });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
      return;
    }
    if (url.pathname === "/api/info" || url.pathname === "/api/download" || url.pathname === "/api/playlist") {
      const input = url.searchParams.get("url") ?? "";
      const videoId = parseVideoId(input);
      const listId = input.match(/[?&]list=([A-Za-z0-9_-]+)/)?.[1] ?? null;
      if (url.pathname === "/api/playlist") {
        if (!listId) return sendJson(res, 400, { error: "That link has no playlist (no list= parameter)." });
        return await handlePlaylist(res, listId, videoId);
      }
      if (!videoId) {
        return sendJson(res, 400, { error: "That doesn't look like a YouTube link. Paste a youtube.com or youtu.be URL." });
      }
      if (url.pathname === "/api/info") return await handleInfo(res, videoId);
      return await handleDownload(res, videoId);
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 502, { error: err.message ?? "Extraction failed." });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`tydle mp3 frontend running at http://${HOST}:${PORT}`);
});
