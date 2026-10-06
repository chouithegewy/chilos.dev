const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const audio = {
  fileSize: 4, source: { url: "https://media.example/audio" },
  codec: { acodec: "opus" }, ext: "webm", formatDuration: 1000,
};

function loadServer(fetch, spawn, { env = {}, execFile } = {}) {
  const context = vm.createContext({
    AbortController, URL, fetch, process: { env, execPath: process.execPath }, __dirname,
    console: { log() {}, error() {} },
    require(id) {
      if (id === "../pkg/tydle.js") return { TydleClient: class {
        async fetchVideoInfo() { return { title: "test", channel: { name: "artist" } }; }
        async fetchStreams() { return { streams: [audio] }; }
      } };
      if (id === "node:http") return { createServer: () => ({ listen() {} }) };
      if (id === "node:child_process") return { spawn, execFile };
      return require(id);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "server.js"), "utf8") +
    "\nglobalThis.api = { extract, pipeSourceToFfmpeg, handleDownload };", context);
  return context.api;
}

function response(status, headers, bytes) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: new Headers(headers),
    body: (async function* () { yield Buffer.from(bytes); })(),
  };
}

function destination() {
  const chunks = [];
  const stream = new Writable({ write(chunk, encoding, callback) {
    stream.headersSent = true;
    chunks.push(Buffer.from(chunk)); callback();
  } });
  stream.headersSent = false;
  stream.writeHead = (status, headers) => {
    stream.statusCode = status;
    stream.responseHeaders = headers;
  };
  stream.bytes = () => Buffer.concat(chunks).toString();
  return stream;
}

test("source download advances through complete ranges without duplicating bytes", async () => {
  const requests = [];
  const api = loadServer(async (url, options) => {
    requests.push(options.headers.Range);
    return requests.length === 1
      ? response(206, { "Content-Range": "bytes 0-1/4" }, "ab")
      : response(206, { "Content-Range": "bytes 2-3/4" }, "cd");
  });
  const dest = destination();
  await api.pipeSourceToFfmpeg(audio, dest, new AbortController().signal);
  assert.deepEqual(requests, ["bytes=0-3", "bytes=2-3"]);
  assert.equal(dest.bytes(), "abcd");
  assert.equal(dest.writableEnded, true);
});

test("source download rejects a truncated range", async () => {
  const api = loadServer(async () => response(206, { "Content-Range": "bytes 0-3/4" }, "abc"));
  const dest = destination();
  await assert.rejects(api.pipeSourceToFfmpeg(audio, dest), /Incomplete YouTube range/);
  assert.equal(dest.writableEnded, false);
});

test("source download rejects a truncated full response without Content-Length", async () => {
  const api = loadServer(async () => response(200, {}, "abc"));
  await assert.rejects(api.pipeSourceToFfmpeg(audio, destination()), /Incomplete YouTube stream/);
});

test("source download accepts a complete full response when Range is ignored", async () => {
  let requests = 0;
  const api = loadServer(async () => {
    requests++; return response(200, { "Content-Length": "4" }, "abcd");
  });
  const dest = destination();
  await api.pipeSourceToFfmpeg(audio, dest);
  assert.equal(dest.bytes(), "abcd");
  assert.equal(requests, 1);
});

test("source download rejects inconsistent Content-Range totals", async () => {
  let requests = 0;
  const api = loadServer(async () => ++requests === 1
    ? response(206, { "Content-Range": "bytes 0-1/4" }, "ab")
    : response(206, { "Content-Range": "bytes 2-3/3" }, "cd"));
  await assert.rejects(api.pipeSourceToFfmpeg(audio, destination()), /Unexpected YouTube/);
});

function fakeFfmpeg() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdin.resume();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.stdout.destroy(); child.emit("close", null); };
  return child;
}

for (const exitCode of [0, 1]) {
  test(`HTTP completion waits for ffmpeg and handles exit code ${exitCode}`, async () => {
    const child = fakeFfmpeg();
    const api = loadServer(async () => response(206, { "Content-Range": "bytes 0-3/4" }, "abcd"), () => child);
    const res = destination();
    const errors = [];
    res.on("error", (error) => errors.push(error));
    await api.handleDownload(res, "example");
    await tick();
    child.stdout.end("mp3");
    await tick();
    assert.equal(res.writableEnded, false, "stdout ending must not finish the HTTP response");
    child.emit("close", exitCode);
    await tick();
    assert.equal(res.writableEnded, exitCode === 0);
    assert.equal(errors.length, exitCode === 0 ? 0 : 1);
    assert.equal(res.bytes(), "mp3");
  });
}

test("disconnect cancels source fetching and terminates ffmpeg", async () => {
  const child = fakeFfmpeg();
  let sourceSignal;
  const api = loadServer((url, { signal }) => {
    sourceSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  }, () => child);
  const res = destination();
  res.on("error", () => {});
  await api.handleDownload(res, "example");
  res.destroy();
  await tick();
  assert.equal(sourceSignal.aborted, true);
  assert.equal(child.killed, true);
});

test("a truncated source returns a readable error before output and terminates ffmpeg", async () => {
  const child = fakeFfmpeg();
  const api = loadServer(async () => response(206, { "Content-Range": "bytes 0-3/4" }, "abc"), () => child);
  const res = destination();
  const errors = [];
  res.on("error", (error) => errors.push(error));
  await api.handleDownload(res, "example");
  await tick();
  assert.equal(res.writableEnded, true);
  assert.equal(child.killed, true);
  assert.equal(errors.length, 0);
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.bytes()).error, /Incomplete YouTube range/);
});

test("a rejected YouTube source returns JSON instead of closing before HTTP headers", async () => {
  const child = fakeFfmpeg();
  const api = loadServer(async () => response(403, {}, ""), () => child);
  const res = destination();
  await api.handleDownload(res, "example");
  await tick();
  assert.equal(res.statusCode, 502);
  assert.equal(res.responseHeaders["Content-Type"], "application/json");
  assert.match(JSON.parse(res.bytes()).error, /YouTube stream request failed \(HTTP 403\)/);
  assert.equal(child.killed, true);
});

test("configured yt-dlp provides a complete source with its required request headers", async () => {
  const bytes = Buffer.alloc(1024 * 1024, "a");
  const sourceUrl = "https://media.example/audio?dur=236.041";
  const api = loadServer(async (url, options) => {
    assert.equal(url, sourceUrl);
    assert.equal(options.headers["User-Agent"], "extractor-agent");
    assert.equal(options.headers.Range, `bytes=0-${bytes.length - 1}`);
    return response(206, { "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}` }, bytes);
  }, undefined, {
    env: { YT_DLP_PATH: "/test/yt-dlp" },
    execFile(file, args, options, callback) {
      assert.equal(file, "/test/yt-dlp");
      assert.ok(args.includes("--ignore-config"));
      assert.ok(args.includes(`node:${process.execPath}`));
      assert.ok(args.includes("bestaudio[protocol=https]/bestaudio[protocol=http]"));
      assert.equal(args.at(-1), "https://www.youtube.com/watch?v=FmA8gUGAvUQ");
      assert.equal(options.timeout, 45_000);
      callback(null, JSON.stringify({
        title: "Santa Fe Klan - Así Soy", channel: "Santa Fe Klan", duration: 236,
        url: sourceUrl, ext: "webm", acodec: "opus", vcodec: "none", abr: 131,
        filesize: bytes.length, http_headers: { "User-Agent": "extractor-agent" },
      }));
    },
  });
  const extracted = await api.extract("FmA8gUGAvUQ");
  assert.equal(extracted.info.title, "Santa Fe Klan - Así Soy");
  assert.equal(extracted.audio.formatDuration, 236041);
  assert.equal(extracted.audio.tbr, 131000);
  const dest = destination();
  await api.pipeSourceToFfmpeg(extracted.audio, dest);
  assert.equal(dest.bytes().length, bytes.length);
  assert.equal(dest.writableEnded, true);
});

test("extractor failures do not leak command details into the browser error", async () => {
  const api = loadServer(undefined, undefined, {
    env: { YT_DLP_PATH: "/test/yt-dlp" },
    execFile(file, args, options, callback) {
      callback(new Error("command failed with private source URL"));
    },
  });
  await assert.rejects(api.extract("example"), /YouTube extraction failed/);
});

test("disconnect during extraction cancels the subprocess without starting ffmpeg", async () => {
  let signal;
  const api = loadServer(undefined, () => assert.fail("ffmpeg must not start"), {
    env: { YT_DLP_PATH: "/test/yt-dlp" },
    execFile(file, args, options, callback) {
      signal = options.signal;
      signal.addEventListener("abort", () => callback(new Error("aborted")));
    },
  });
  const res = destination();
  const download = api.handleDownload(res, "example");
  res.destroy();
  await assert.rejects(download, /aborted/i);
  assert.equal(signal.aborted, true);
});

function loadBrowser(fetch) {
  const elements = new Map();
  const downloads = [], revoked = [], timers = [];
  function element() {
    return {
      style: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, appendChild() {}, remove() {},
      click() { downloads.push(this); },
    };
  }
  const context = vm.createContext({
    fetch, Blob, performance: { now: () => 1000 },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: (url) => revoked.push(url) },
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
    document: {
      body: element(), createElement: element,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
    },
  });
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1] +
    "\nglobalThis.api = { setProgress, downloadOne };", context);
  return { api: context.api, elements, downloads, revoked, timers };
}

test("estimated progress caps at 99% and completed progress reaches 100%", () => {
  const { api, elements } = loadBrowser();
  api.setProgress(1.2, "ripping");
  assert.equal(elements.get("fill").style.width, "99%");
  assert.equal(elements.get("stPct").textContent, "99%");
  api.setProgress(1, "saved", "", true);
  assert.equal(elements.get("fill").style.width, "100%");
  assert.equal(elements.get("stPct").textContent, "100%");
});

test("browser saves only after stream completion and delays Blob URL cleanup", async () => {
  let read = 0, end;
  const browser = loadBrowser(async () => ({
    ok: true, headers: new Headers(),
    body: { getReader: () => ({ read: () => ++read === 1
      ? Promise.resolve({ done: false, value: Uint8Array.from([1, 2]) })
      : new Promise((resolve) => { end = resolve; }) }) },
  }));
  const download = browser.api.downloadOne("example", "ripping");
  await tick();
  assert.equal(browser.downloads.length, 0);
  end({ done: true });
  assert.equal(await download, "audio.mp3");
  assert.equal(browser.downloads.length, 1);
  assert.equal(browser.revoked.length, 0);
  assert.equal(browser.timers[0].delay, 30_000);
  browser.timers[0].fn();
  assert.deepEqual(browser.revoked, ["blob:test"]);
});

test("browser rejects a broken stream without saving a partial file", async () => {
  let read = 0;
  const browser = loadBrowser(async () => ({
    ok: true, headers: new Headers(),
    body: { getReader: () => ({ read: async () => {
      if (++read === 1) return { done: false, value: Uint8Array.from([1]) };
      throw new Error("connection closed");
    } }) },
  }));
  await assert.rejects(browser.api.downloadOne("example", "ripping"), /connection closed/);
  assert.equal(browser.downloads.length, 0);
});
