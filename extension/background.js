// Psalm101 background: 100% local on-device image and video filtering.  Caches verdicts per URL, holds the
// filtering level, video-filtering toggle, and optional parent password, and routes checks to the local
// offscreen ONNX Runtime Web engine.
importScripts('rules.js');
const api = globalThis.browser ?? globalThis.chrome;
const { decide } = globalThis.PsalmRules;
const CONCURRENCY = 8;
const MAX_CACHE = 5000;
const DEFAULTS = { level: 0, video: true };   // new installs: Very strict, video filtering on
const LEGACY_KEYS = ['serverUrl', 'serverToken', 'model', 'engine'];

const problems = [];
const record = (level, args) => {
  problems.push(`${level}: ${args.map(String).join(' ').slice(0, 300)}`);
  if (problems.length > 20) problems.shift();
};
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { record(level, a); orig(...a); };
}
self.addEventListener?.('error', (e) => record('error', [e.message]));
self.addEventListener?.('unhandledrejection', (e) => record('error', [e.reason]));

const cache = new Map();          // image URL -> verdict with probabilities (LRU order)
const queue = [];                 // pending image jobs, lowest priority value first
let active = 0;
const blockedByTab = new Map();   // tabId -> Map(frameId -> count)
const lat = {};                   // kind -> typical end-to-end ms (median of recent)
const samples = {};               // kind -> {n, recent: [ms]}
const counts = { image: 0, frame: 0 };

// ---------- settings (storage.local, overridden by browser policy: storage.managed) ----------
let settings = { ...DEFAULTS }, managed = {};
const ready = loadSettings();
async function loadSettings() {
  const local = await api.storage.local.get(null).catch(() => ({}));
  const stale = LEGACY_KEYS.filter((k) => k in local);
  if (stale.length) {
    stale.forEach((k) => delete local[k]);
    api.storage.local.remove(stale).catch(() => {});
  }
  managed = await (api.storage.managed?.get(null) ?? Promise.resolve({})).catch(() => ({}));
  settings = { ...DEFAULTS, ...local, ...managed };
}
api.storage.onChanged.addListener((changes) => loadSettings().then(() => {
  if ('level' in changes || 'video' in changes) {
    broadcast({ type: 'policy', level: settings.level, video: settings.video !== false });
  }
}));
function broadcast(msg) {
  api.tabs?.query({}).then((tabs) => tabs.forEach((t) => api.tabs.sendMessage(t.id, msg).catch(() => {})), () => {});
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function unlockedUntil() { return (await api.storage.session?.get('unlockedUntil').catch(() => ({})))?.unlockedUntil ?? 0; }
async function isUnlocked() { return !settings.passwordHash || Date.now() < (await unlockedUntil()); }

// ---------- on-device engine (offscreen document running ONNX Runtime Web) ----------
function measure(kind, ms) {
  const m = (samples[kind] ??= { n: 0, recent: [] });
  counts[kind] = (counts[kind] ?? 0) + 1;
  if (++m.n <= 2) return;
  m.recent.push(ms);
  if (m.recent.length > 15) m.recent.shift();
  const sorted = [...m.recent].sort((a, b) => a - b);
  lat[kind] = sorted[sorted.length >> 1];
}

async function hasEngine() {
  if (!api.offscreen) return false;
  return api.runtime.getContexts
    ? (await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0
    : await api.offscreen.hasDocument();
}

let creating = null;
async function ensureEngine() {
  if (!api.offscreen) throw new Error('this browser has no offscreen documents');
  if (await hasEngine()) return;
  creating ??= api.offscreen.createDocument({
    url: 'engine.html', reasons: ['WORKERS'], justification: 'Runs the Psalm101 image checks locally, on this device',
  }).finally(() => { creating = null; });
  await creating;
}

async function builtin(msg) {
  await ready;
  try {
    await ensureEngine();
    const r = await api.runtime.sendMessage({ target: 'engine', level: settings.level, ...msg });
    return r ?? { block: true, offline: true };
  } catch (e) {
    return { block: true, offline: true, reason: String(e) };
  }
}

// Every answer is decided here from its probabilities with the current filtering level.
function verdict(v) {
  if (v && v.p) {
    v.m = 'accurate';
    v.block = decide(v.p, v.m, settings.level);
  }
  return v;
}

function remember(url, v) {
  cache.delete(url);
  cache.set(url, v);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

function run(prio, job) {
  return new Promise((resolve) => {
    queue.push({ prio, job, resolve });
    queue.sort((a, b) => a.prio - b.prio);
    pump();
  });
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const { job, resolve } = queue.shift();
    active++;
    job().then(resolve, () => resolve({ block: true, offline: true })).finally(() => { active--; pump(); });
  }
}

async function classifyImage(msg) {
  const url = msg.url;
  const key = msg.key ?? url;
  if (key && cache.has(key)) {
    const v = cache.get(key);
    remember(key, v);
    return verdict({ ...v });
  }
  return run(msg.priority ?? 0, async () => {
    const t0 = performance.now();
    const v = verdict(await builtin({ op: 'image', url: msg.data ? undefined : msg.url, data: msg.data, priority: msg.priority }));
    if (v.p) measure('image', performance.now() - t0);
    if (key && !v.offline && !v.unverified && !key.startsWith('data:')) remember(key, v);
    return v;
  });
}

async function classifyFrame(msg) {
  const t0 = performance.now();
  const v = verdict(await builtin({ op: 'frame', data: msg.data }));
  if (v.p) measure('frame', performance.now() - t0);
  return v;
}

function badge(tabId, frameId, n, reset = false) {
  if (tabId == null || !api.action) return;
  const m = reset ? new Map() : (blockedByTab.get(tabId) ?? new Map());
  m.set(frameId ?? 0, n);
  blockedByTab.set(tabId, m);
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  api.action.setBadgeText({ tabId, text: total ? String(total) : '' });
  api.action.setBadgeBackgroundColor?.({ tabId, color: '#46607a' });
}

// Backstop: capture the visible tab strictly when there are unreadable candidates (canvas, cross-origin video,
// unverified CSS backgrounds).
let lastCapture = 0;
async function sweep(msg, sender) {
  const tab = sender.tab;
  if (!tab || !tab.active || !api.tabs?.captureVisibleTab) return null;
  if (!(msg.candidates?.length)) return { flagged: [], found: [] };
  const now = Date.now();
  if (now - lastCapture < 1000) return null;
  lastCapture = now;
  let shot;
  try { shot = await api.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 }); } catch (e) { return null; }
  const body = { image: shot.split(',')[1], viewport: msg.viewport, masks: msg.masks, candidates: msg.candidates };
  return builtin({ op: 'sweep', ...body });
}

// ---------- popup & details ----------
async function brief(tabId) {
  await ready;
  const mode = api.offscreen ? 'builtin' : 'offline';
  let backend = null;
  if (mode === 'builtin') {
    if (await hasEngine()) {
      const eng = await builtin({ op: 'stats' });
      backend = eng?.ep ?? null;
    } else {
      builtin({ op: 'warm' }).catch(() => {});
    }
  }
  const hidden = tabId == null ? 0 : [...(blockedByTab.get(tabId)?.values() ?? [])].reduce((a, b) => a + b, 0);
  return {
    level: settings.level,
    video: settings.video !== false,
    mode,
    backend,
    ready: !!backend,
    hidden,
    managed: Object.keys(managed),
    locked: !(await isUnlocked()),
    hasPassword: !!settings.passwordHash,
  };
}

async function status() {
  await ready;
  const mode = api.offscreen ? 'builtin' : 'offline';
  const eng = mode === 'builtin' ? await builtin({ op: 'stats' }) : null;
  const round = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    version: api.runtime.getManifest?.().version ?? '',
    settings: { level: settings.level, video: settings.video !== false },
    managed: Object.keys(managed),
    locked: !(await isUnlocked()),
    hasPassword: !!settings.passwordHash,
    mode,
    latency: { image: round(lat.image), frame: round(lat.frame) },
    counts: { image: counts.image, frame: counts.frame, total: counts.image + counts.frame },
    backend: eng?.ep ?? null,
    failed: eng?.failed ?? [],
    gpu: eng?.gpu ?? null,
    threads: eng?.threads ?? null,
    webnn: eng?.webnn ?? false,
    prepMs: round(eng?.prepMs),
    runMs: round(eng?.runMs),
    problems: [...problems.map((x) => `background ${x}`), ...(eng?.problems ?? []).map((x) => `engine ${x}`)],
  };
}

async function setSetting(msg) {
  await ready;
  if (!(await isUnlocked())) return { error: 'locked' };
  if (msg.key in managed) return { error: 'set by your administrator' };
  if (msg.key === 'password') {
    const salt = crypto.randomUUID();
    await api.storage.local.set({ passwordSalt: salt, passwordHash: msg.value ? await sha256(salt + msg.value) : '' });
    return { ok: true };
  }
  if (msg.key === 'video') {
    await api.storage.local.set({ video: !!msg.value });
    return { ok: true };
  }
  if (msg.key !== 'level') return { error: 'unknown setting' };
  await api.storage.local.set({ level: msg.value });
  return { ok: true };
}

async function unlock(msg) {
  await ready;
  if (!settings.passwordHash) return { ok: true };
  if ((await sha256((settings.passwordSalt ?? '') + msg.password)) !== settings.passwordHash) return { error: 'wrong password' };
  await api.storage.session?.set({ unlockedUntil: Date.now() + 5 * 60 * 1000 });
  return { ok: true };
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.target === 'engine') return false;
  const reply = (p) => { p.then(sendResponse, (e) => sendResponse({ error: String(e) })); return true; };
  switch (msg.type) {
    case 'classify': return reply(classifyImage(msg));
    case 'frame': return reply(classifyFrame(msg));
    case 'sweep': return reply(sweep(msg, sender));
    case 'policy': return reply(ready.then(() => ({ level: settings.level, video: settings.video !== false })));
    case 'status': return reply(status());
    case 'brief': return reply(brief(msg.tabId));
    case 'bench': return reply(builtin({ op: 'bench' }));
    case 'set': return reply(setSetting(msg));
    case 'unlock': return reply(unlock(msg));
    case 'lock': return reply(api.storage.session?.set({ unlockedUntil: 0 }).then(() => ({ ok: true })) ?? Promise.resolve({ ok: true }));
    case 'count': badge(sender.tab?.id, sender.frameId, msg.blocked, !!msg.reset); return false;
    default: return false;
  }
});

api.tabs?.onRemoved?.addListener((tabId) => blockedByTab.delete(tabId));
api.tabs?.onUpdated?.addListener((tabId, info) => {
  if (info.status === 'loading') {
    blockedByTab.delete(tabId);
    api.action?.setBadgeText({ tabId, text: '' });
  }
});

// Warm up the on-device classifier at startup so the first page doesn't wait.
const warm = () => ready.then(() => { if (api.offscreen) builtin({ op: 'warm' }); });
api.runtime.onStartup?.addListener(warm);
api.runtime.onInstalled?.addListener(warm);
