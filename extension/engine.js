// Psalm101 built-in engine: runs the single on-device SigLIP2-B/16 classifier inside Chrome's offscreen document
// via ONNX Runtime Web.  100% local — nothing leaves the device.
//
// Backends, best first: WebNN (Neural Engine / NPU or GPU), WebGPU (GPU), WebAssembly (multi-threaded CPU).
import * as ort from './vendor/ort.webgpu.min.mjs';
import { blocks, slider, ruleFor, tilesFor } from './policy.js';

const api = globalThis.browser ?? globalThis.chrome;
const problems = [];
const record = (level, args) => {
  problems.push(`${level}: ${args.map(String).join(' ').slice(0, 300)}`);
  if (problems.length > 20) problems.shift();
};
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { record(level, a); orig(...a); };
}
addEventListener('error', (e) => record('error', [e.message]));
addEventListener('unhandledrejection', (e) => record('error', [e.reason]));

ort.env.wasm.wasmPaths = api.runtime.getURL('vendor/');
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
ort.env.logLevel = 'error';
ort.env.debug = false;

const MODEL_FILE = 'models/accurate.fp16.onnx';
const SIZE = 256;
let modelSession = null;
const stats = { checks: 0, ms: 0, last: [], prep: [], run: [], batch: [], ep: null, failed: [] };

function backends() {
  const order = [];
  if (navigator.ml) order.push({ name: 'webnn', deviceType: 'npu' }, { name: 'webnn', deviceType: 'gpu' });
  if (navigator.gpu) order.push('webgpu');
  order.push('wasm');
  return order;
}

// ONNX Runtime's WebAssembly runtime can't take a second call while one is in progress: creating a session while
// another runs corrupts it.  Session creation, warm-up and inference all go through one queue.
function session() {
  modelSession ??= schedule(-1, async () => {
    const url = api.runtime.getURL(MODEL_FILE);
    stats.failed = [];
    for (const ep of backends()) {
      const label = typeof ep === 'string' ? ep : `${ep.name}-${ep.deviceType}`;
      try {
        const webnn = typeof ep !== 'string';
        const s = await ort.InferenceSession.create(url, {
          executionProviders: [ep], graphOptimizationLevel: 'all', logSeverityLevel: 3,
          ...(webnn ? { freeDimensionOverrides: { n: 1 } } : {}),
        });
        // Warm-up: compile programs up front for each batch size (1, 2, 4, 8) instead of stalling a page load.
        const sizes = webnn ? [1] : [1, 2, 4, 8];
        for (const n of sizes) {
          await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', new Float32Array(n * 3 * SIZE * SIZE), [n, 3, SIZE, SIZE]) });
        }
        stats.ep = label;
        return { session: s, ep: label, input: s.inputNames[0], output: s.outputNames[0], maxBatch: webnn ? 1 : 8 };
      } catch (e) {
        stats.failed.push(`${label}: ${String(e?.message ?? e).slice(0, 160)}`);
        console.info(`psalm101: model can't run on ${label}:`, String(e).slice(0, 300));
      }
    }
    throw new Error('no backend could run the classifier');
  });
  modelSession.catch(() => { modelSession = null; });
  return modelSession;
}

// One model run at a time; video frames go first, alternating with waiting images so neither starves.
const queue = [];
let running = false;
function schedule(prio, fn) {
  return new Promise((resolve, reject) => {
    queue.push({ prio, fn, resolve, reject });
    queue.sort((a, b) => a.prio - b.prio);
    pump();
  });
}

let lastWasFrame = false;
let lastFrameAt = 0;
async function pump() {
  if (running || !queue.length) return;
  running = true;
  let i = 0;
  if (lastWasFrame) {
    const k = queue.findIndex((q) => q.prio > 0);
    if (k >= 0) i = k;
  }
  const j = queue.splice(i, 1)[0];
  const isFrame = j.prio === 0;
  lastWasFrame = isFrame;
  if (isFrame) lastFrameAt = performance.now();
  if (j.run) {
    const batch = [j];
    // Video frames run solo (~30 ms) so they never wait on an image batch; while video is active,
    // keep image batches small (<= 2) so a thumbnail burst never stalls video playback.
    const videoActive = performance.now() - lastFrameAt < 2000;
    const cap = isFrame ? 1 : videoActive ? Math.min(2, j.run.m.maxBatch) : j.run.m.maxBatch;
    for (let k = 0; k < queue.length && batch.length < cap; ) {
      if (queue[k].run && queue[k].prio > 0) batch.push(queue.splice(k, 1)[0]); else k++;
    }
    try {
      const rows = await runBatch(j.run.m, batch.map((b) => b.run.input));
      batch.forEach((b, n) => b.resolve(rows[n]));
    } catch (e) { batch.forEach((b) => b.reject(e)); }
  } else {
    try { j.resolve(await j.fn()); } catch (e) { j.reject(e); }
  }
  running = false;
  pump();
}

function enqueueRun(prio, m, input) {
  return new Promise((resolve, reject) => {
    queue.push({ prio, run: { m, input }, resolve, reject });
    queue.sort((a, b) => a.prio - b.prio);
    pump();
  });
}

async function runBatch(m, inputs) {
  const per = 3 * SIZE * SIZE, n = inputs.length;
  const padded = n === 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : 8;
  const data = new Float32Array(per * padded);
  inputs.forEach((t, i) => data.set(t.data, i * per));
  const t1 = performance.now();
  const out = await m.session.run({ [m.input]: new ort.Tensor('float32', data, [padded, 3, SIZE, SIZE]) });
  const ms = performance.now() - t1;
  stats.checks += n; stats.ms += ms; keep(stats.last, ms / n); keep(stats.run, ms / n);
  if (n > 1) keep(stats.batch, n);
  const v = out[m.output].data, rows = [];
  for (let i = 0; i < n; i++) {
    const p = Array.from(v.slice(4 * i, 4 * i + 4));
    const total = p.reduce((a, b) => a + b, 0) || 1;
    rows.push(p.map((x) => x / total));
  }
  return rows;
}

const canvas = new OffscreenCanvas(SIZE, SIZE);
const g = canvas.getContext('2d', { willReadFrequently: true });
g.imageSmoothingQuality = 'high';

// RGB planes in 0..1 (normalization is inside the model).  The crop is stretched to the input, as in training.
function tensor(src, [sx, sy, sw, sh]) {
  g.fillStyle = '#727272';
  g.fillRect(0, 0, SIZE, SIZE);
  g.drawImage(src, sx, sy, sw, sh, 0, 0, SIZE, SIZE);
  const d = g.getImageData(0, 0, SIZE, SIZE).data;
  const n = SIZE * SIZE, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { f[i] = d[4 * i] / 255; f[n + i] = d[4 * i + 1] / 255; f[2 * n + i] = d[4 * i + 2] / 255; }
  return new ort.Tensor('float32', f, [1, 3, SIZE, SIZE]);
}

// Shrink the region to 256×256 while decoding (outside the model queue, so prep overlaps inference).
async function prepare(src, [sx, sy, sw, sh]) {
  const W = src.width, H = src.height;
  const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
  const x1 = Math.min(W, Math.ceil(sx + sw)), y1 = Math.min(H, Math.ceil(sy + sh));
  const small = await createImageBitmap(src, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0),
                                        { resizeWidth: SIZE, resizeHeight: SIZE, resizeQuality: 'high' });
  const t = tensor(small, [0, 0, SIZE, SIZE]);
  small.close();
  return t;
}

const keep = (arr, v) => { arr.push(v); if (arr.length > 50) arr.shift(); };
const median = (arr) => { const l = [...arr].sort((a, b) => a - b); return l.length ? l[l.length >> 1] : null; };

async function probs(src, rect, prio) {
  const m = await session();
  const t0 = performance.now();
  const input = await prepare(src, rect);
  keep(stats.prep, performance.now() - t0);
  return enqueueRun(prio, m, input);
}

// Speed test: 12 runs on a blank input (no image preparation), median ms.
async function bench() {
  const m = await session();
  const x = new ort.Tensor('float32', new Float32Array(3 * SIZE * SIZE).fill(0.5), [1, 3, SIZE, SIZE]);
  const times = [];
  for (let i = 0; i < 12; i++) {
    const t = await schedule(1, async () => {
      const t0 = performance.now();
      await m.session.run({ [m.input]: x });
      return performance.now() - t0;
    });
    times.push(t);
  }
  return { ms: median(times), on: m.ep };
}

function b64Blob(b64) {
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return new Blob([u]);
}

const decide = (p, rule) => ({ block: blocks(rule, p), p, m: 'accurate' });

// An image file (URL or bytes): whole image, or overlapping square tiles for very tall/wide images.
async function image(msg) {
  let blob;
  if (msg.data) blob = b64Blob(msg.data);
  else {
    try {
      const r = await fetch(msg.url, { credentials: 'include' });
      if (!r.ok) return { block: false, unverified: true, reason: `image fetch ${r.status}` };
      blob = await r.blob();
    } catch (e) { return { block: false, unverified: true, reason: 'image fetch failed' }; }
  }
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch (e) { return { block: false, unverified: true, reason: 'not an image we can read' }; }
  if (bmp.width < 40 && bmp.height < 40) { bmp.close(); return { block: false, reason: 'small' }; }
  const rule = ruleFor(msg.level);
  let worst = null;
  for (const t of tilesFor(bmp.width, bmp.height)) {
    const p = await probs(bmp, t, 2 + Math.min(msg.priority ?? 0, 5000) / 5000);
    if (!worst || (blocks(rule, p) && !blocks(rule, worst)) || slider(p) > slider(worst)) worst = p;
  }
  bmp.close();
  return decide(worst, rule);
}

// A video frame: checked directly with the on-device classifier at highest priority.
async function frame(msg) {
  const bmp = await createImageBitmap(b64Blob(msg.data));
  const p = await probs(bmp, [0, 0, bmp.width, bmp.height], 0);
  bmp.close();
  return decide(p, ruleFor(msg.level));
}

// The tab-capture backstop: checks only the explicit DOM candidates the page script couldn't read
// (canvas, cross-origin video, unverified CSS backgrounds).
async function sweep(msg) {
  const candidates = msg.candidates ?? [];
  if (!candidates.length) return { flagged: [], found: [] };
  const bmp = await createImageBitmap(b64Blob(msg.image));
  const k = bmp.width / msg.viewport[0];
  const rule = ruleFor(msg.level);
  const flagged = [];
  for (const [i, r] of candidates.entries()) {
    const [x, y, w, h] = [r[0] * k, r[1] * k, r[2] * k, r[3] * k];
    if (w < 24 || h < 24) continue;
    if (blocks(rule, await probs(bmp, [x, y, w, h], 3))) flagged.push(i);
  }
  bmp.close();
  return { flagged, found: [] };
}

const ops = {
  image, frame, sweep,
  async warm() {
    await session();
    return { ok: true, ep: stats.ep };
  },
  async bench() { return { bench: await bench() }; },
  async stats() {
    let gpu = null;
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter().catch(() => null);
      gpu = a ? { vendor: a.info?.vendor ?? '', arch: a.info?.architecture ?? '', f16: a.features.has('shader-f16') } : 'no adapter';
    } else gpu = 'WebGPU not available in this browser';
    return {
      checks: stats.checks,
      msMedian: median(stats.last),
      prepMs: median(stats.prep),
      runMs: median(stats.run),
      batchAvg: stats.batch.length ? stats.batch.reduce((a, b) => a + b, 0) / stats.batch.length : 1,
      ep: stats.ep,
      failed: stats.failed,
      problems,
      gpu,
      threads: ort.env.wasm.numThreads,
      webnn: !!navigator.ml,
    };
  },
};

// A crashed WebAssembly runtime can't recover: reload the engine page (callers retry; images stay hidden meanwhile).
let restarting = false;
function crashed(e) {
  const m = String(e?.message ?? e);
  if (restarting || !/memory access out of bounds|Aborted|unreachable|RuntimeError/.test(m)) return;
  restarting = true;
  record('error', [`runtime crashed, restarting the engine: ${m}`]);
  setTimeout(() => location.reload(), 50);
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'engine' || !ops[msg.op]) return false;
  if (restarting) { sendResponse({ error: 'engine restarting', offline: true }); return false; }
  const t0 = performance.now();
  ops[msg.op](msg).then(
    (r) => sendResponse({ ...r, policy: `${msg.level}-builtin`, ms: performance.now() - t0, engine: 'builtin' }),
    (e) => { crashed(e); sendResponse({ error: String(e), offline: true }); },
  );
  return true;
});
