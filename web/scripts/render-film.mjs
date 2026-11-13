// Renders the Bakeoff demo film to an MP4, frame by frame, on a virtual clock.
//
// Headless Chrome loads /#/demo?render with the page's clocks replaced:
// timers, requestAnimationFrame, performance.now and Date all follow a
// virtual time this script advances by exactly 1/fps per frame. CSS
// animations are paused and set to that time too, and Motion falls back to
// its JavaScript animations (Element.animate is removed), which follow the
// same clock. Each frame is captured and piped into ffmpeg, so the video is
// smooth whatever the capture speed.
//
// Usage, with the dev server running (npm run dev -- --port 5180):
//   npm run film -- [out.mp4] [fps] [seconds]
// FILM_URL overrides the page (default http://localhost:5180/#/demo?render);
// add &scene=<id>&at=<ms> to it to render from one moment. CHROME_PATH
// overrides the browser (default: Google Chrome on macOS). Needs ffmpeg.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [outArg, fpsArg, limitArg] = process.argv.slice(2);
const url = process.env.FILM_URL || "http://localhost:5180/#/demo?render";
const out = outArg || "bakeoff-demo.mp4";
const FPS = Number(fpsArg) || 60;
const LIMIT = Number(limitArg) || 0;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

const FAKE_TIME = `(() => {
  const realSetTimeout = window.setTimeout.bind(window);
  const realSetInterval = window.setInterval.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  const realNow = performance.now.bind(performance);
  const RealDate = Date;
  const epoch = RealDate.now();
  let now = 0;
  const timers = new Map();
  let nextTimer = 1;
  const frames = new Map();
  let nextFrame = 1;

  performance.now = () => now;
  function FakeDate(...args) {
    if (!(this instanceof FakeDate)) return new RealDate(epoch + now).toString();
    return args.length ? new RealDate(...args) : new RealDate(epoch + now);
  }
  FakeDate.now = () => epoch + now;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  window.Date = FakeDate;

  window.setTimeout = (fn, ms = 0, ...args) => { const id = nextTimer++; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, every: 0 }); return id; };
  window.setInterval = (fn, ms = 0, ...args) => { const every = Math.max(1, Number(ms) || 0); const id = nextTimer++; timers.set(id, { at: now + every, fn, args, every }); return id; };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.requestAnimationFrame = (fn) => { const id = nextFrame++; frames.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  // Motion then runs every animation on requestAnimationFrame, which this clock drives.
  delete Element.prototype.animate;

  function advance(ms) {
    const target = now + ms;
    for (;;) {
      let due = null;
      for (const entry of timers) if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      const [id, timer] = due;
      now = Math.max(now, timer.at);
      if (timer.every) timer.at += timer.every; else timers.delete(id);
      try { typeof timer.fn === "function" ? timer.fn(...timer.args) : eval(timer.fn); } catch (e) { console.error(e); }
    }
    now = target;
    const callbacks = [...frames.values()];
    frames.clear();
    for (const fn of callbacks) { try { fn(now); } catch (e) { console.error(e); } }
  }

  // CSS animations: paused, and set to how long they have run on this clock.
  function syncCss() {
    for (const a of document.getAnimations()) {
      if (a.__start === undefined) { a.__start = now - (Number(a.currentTime) || 0); a.pause(); }
      a.currentTime = Math.max(0, now - a.__start);
    }
  }
  const tick = () => new Promise((resolve) => realSetTimeout(resolve, 0));

  // Until the film says it is ready, time runs at real speed, so loading works as usual.
  let last = realNow();
  const auto = realSetInterval(() => { const t = realNow(); advance(t - last); last = t; }, 16);
  let film;
  Object.defineProperty(window, "__film", {
    configurable: true,
    get: () => film,
    set: (value) => { film = value; realClearInterval(auto); },
  });

  window.__step = async (ms) => {
    advance(ms);
    // Let React commit what the timers and frames changed, then pin CSS to the clock.
    await tick(); await tick(); await tick();
    syncCss();
    return now;
  };
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "film-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--window-size=1920,1080", "--hide-scrollbars", "--force-device-scale-factor=1", "--mute-audio",
  "--no-first-run", "--no-default-browser-check",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  "about:blank",
], { stdio: "ignore" });

let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(150);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
  } catch { /* not up yet */ }
}
if (!target) throw new Error("Chrome did not start");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    console.error("page error:", msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "no-preference" }] });
await send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_TIME });
await send("Page.navigate", { url });

let ready = false;
for (let i = 0; i < 240 && !ready; i++) {
  await sleep(250);
  ready = Boolean(await evaluate("Boolean(window.__film && window.__film.ready)").catch(() => false));
}
if (!ready) throw new Error("the film never reported ready (data or fonts did not load)");
const total = await evaluate("window.__film.total");
const frames = Math.ceil(((LIMIT ? Math.min(LIMIT * 1000, total) : total) / 1000) * FPS) + Math.round(FPS * 0.5);
console.log(`ready: ${total} ms of film, rendering ${frames} frames at ${FPS} fps to ${out}`);

const ffmpeg = spawn("ffmpeg", [
  "-y", "-loglevel", "error",
  "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
  // The JPEG frames are full range; convert to the standard video range, tagged BT.709, so players and X show true colours.
  "-vf", "scale=in_range=pc:out_range=tv,format=yuv420p",
  "-c:v", "libx264", "-preset", "slow", "-crf", "16",
  "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
  "-r", String(FPS), "-movflags", "+faststart", out,
], { stdio: ["pipe", "inherit", "inherit"] });
const write = (buf) => new Promise((resolve) => (ffmpeg.stdin.write(buf) ? resolve() : ffmpeg.stdin.once("drain", resolve)));

const started = Date.now();
const step = 1000 / FPS;
for (let f = 0; f < frames; f++) {
  if (f > 0) await evaluate(`window.__step(${step})`);
  else await evaluate("window.__step(0)");
  const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 95, fromSurface: true });
  await write(Buffer.from(shot.data, "base64"));
  if (f % (FPS * 5) === 0) {
    const done = await evaluate("Boolean(window.__film && window.__film.done)");
    const rate = (f + 1) / ((Date.now() - started) / 1000);
    console.log(`frame ${f}/${frames} · film ${(f / FPS).toFixed(1)} s · ${rate.toFixed(1)} frames/s${done ? " · film ended" : ""}`);
  }
}

ffmpeg.stdin.end();
await new Promise((resolve) => ffmpeg.on("close", resolve));
ws.close();
chrome.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)} s: ${out}`);
