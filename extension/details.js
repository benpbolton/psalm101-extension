// Psalm101 Details: local performance status, parent password, and page diagnostics.
const api = globalThis.browser ?? globalThis.chrome;
const { LEVELS } = globalThis.PsalmRules;
const $ = (id) => document.getElementById(id);
const send = (m) => api.runtime.sendMessage(m);
const BACKEND = {
  webgpu: 'GPU (WebGPU)',
  wasm: 'CPU (WASM)',
  'webnn-npu': 'Neural Engine',
  'webnn-gpu': 'GPU (WebNN)',
};
const ms = (v) => (v == null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
const esc = (t) => String(t ?? '').replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]));
const title = (t) => String(t ?? '').replace(/-(\d)/, ' $1').replace(/\b\w/g, (c) => c.toUpperCase());

let s = null;

async function render() {
  s = await send({ type: 'status' });
  if (!s) return;

  const levelName = LEVELS[s.settings.level] ?? LEVELS[0];
  $('summary').textContent = `${levelName} · 100% on-device`;
  if (s.version) {
    $('about').textContent = `Psalm101 v${s.version} · On-device SigLIP2-B/16 (Apache-2.0) · ONNX Runtime Web (MIT)`;
  }

  // Header badge
  const badge = $('modeBadge');
  if (s.mode === 'offline') {
    badge.className = 'pill warn';
    badge.textContent = 'Offline';
  } else {
    badge.className = 'pill good';
    badge.textContent = 'Private & local';
  }

  // Metrics strip
  $('mBackend').textContent = s.mode === 'offline'
    ? 'Unavailable'
    : s.backend ? (BACKEND[s.backend] ?? s.backend) : 'Starting…';
  $('mSpeed').textContent = ms(s.runMs ?? s.latency?.frame ?? s.latency?.image);
  $('mChecks').textContent = (s.counts?.total ?? 0).toLocaleString();

  // Hardware details
  const rows = [['Model', 'SigLIP2-B/16 (on-device)']];
  if (s.gpu) {
    const gpuText = typeof s.gpu === 'string'
      ? s.gpu
      : [title(s.gpu.vendor), title(s.gpu.arch)].filter(Boolean).join(' · ') + (s.gpu.f16 ? '' : ' (no fp16)');
    if (gpuText) rows.push(['Graphics', gpuText]);
  }
  if (s.latency?.frame != null) rows.push(['Video frame', ms(s.latency.frame)]);
  if (s.backend === 'wasm' && s.threads) rows.push(['CPU threads', String(s.threads)]);
  $('device').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('videoToggle').checked = s.settings.video !== false;
  $('videoToggle').disabled = s.locked || s.managed.includes('video');
  $('videoNote').textContent = s.settings.video !== false
    ? 'Buffers and checks playing video frames. Turn off on slower computers.'
    : 'Off — filtering images only; playing videos are not checked.';
  $('benchRow').hidden = s.mode !== 'builtin';

  // Password
  const managedPw = s.managed.includes('passwordHash');
  const pwBadge = $('pwBadge');
  if (managedPw) {
    pwBadge.className = 'pill good';
    pwBadge.textContent = 'Managed';
  } else if (!s.hasPassword) {
    pwBadge.className = 'pill';
    pwBadge.textContent = 'Not set';
  } else if (s.locked) {
    pwBadge.className = 'pill warn';
    pwBadge.textContent = 'Locked';
  } else {
    pwBadge.className = 'pill good';
    pwBadge.textContent = 'Unlocked';
  }

  $('pwNote').textContent = managedPw
    ? 'The password is managed by your device policy.'
    : !s.hasPassword
      ? 'Set a password so the filtering level can only be changed by a parent.'
      : s.locked
        ? 'Settings are locked. Enter the password to make changes for 5 minutes.'
        : 'Settings are unlocked. Save a new password, remove it, or lock now.';
  $('pwRow').hidden = managedPw;
  $('pw').placeholder = s.hasPassword && s.locked ? 'Password' : s.hasPassword ? 'New password' : 'Choose a password';
  $('pwGo').textContent = s.hasPassword && s.locked ? 'Unlock' : 'Save';
  $('lockRow').hidden = !s.hasPassword || s.locked || managedPw;

  // Troubleshooting
  const probs = (s.problems ?? []).slice(-6);
  $('problems').hidden = probs.length === 0;
  $('problems').innerHTML = probs.map((p) => `<li>${esc(p)}</li>`).join('');
}

async function lastPage() {
  const tabs = (await api.tabs.query({})).filter((t) => /^https?:/.test(t.url ?? ''));
  tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return tabs[0] ?? null;
}

$('videoToggle').addEventListener('change', async () => {
  const r = await send({ type: 'set', key: 'video', value: $('videoToggle').checked });
  $('msg').textContent = r?.error === 'locked'
    ? 'Settings are locked: unlock with the password first.'
    : r?.error ? `Not changed: ${r.error}` : '';
  render();
});

$('bench').addEventListener('click', async () => {
  $('bench').disabled = true;
  $('benchOut').textContent = 'Testing…';
  const r = await send({ type: 'bench' });
  const b = r?.bench;
  $('benchOut').textContent = b?.ms != null
    ? `${ms(b.ms)} per image on ${BACKEND[b.on] ?? b.on}`
    : 'Speed test unavailable.';
  $('bench').disabled = false;
  render();
});

$('pwGo').addEventListener('click', async () => {
  const v = $('pw').value;
  $('pw').value = '';
  if (s?.hasPassword && s.locked) {
    const r = await send({ type: 'unlock', password: v });
    $('msg').textContent = r?.error ? 'Wrong password.' : '';
  } else if (v) {
    const r = await send({ type: 'set', key: 'password', value: v });
    $('msg').textContent = r?.error ? `Not changed: ${r.error}` : 'Password saved.';
  }
  render();
});
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pwGo').click(); });
$('lockNow').addEventListener('click', async () => {
  await send({ type: 'lock' });
  $('msg').textContent = 'Settings locked.';
  render();
});
$('pwClear').addEventListener('click', async () => {
  const r = await send({ type: 'set', key: 'password', value: '' });
  $('msg').textContent = r?.error ? `Not changed: ${r.error}` : 'Password removed.';
  render();
});

$('diag').addEventListener('click', async () => {
  const tab = await lastPage();
  let d = null;
  if (tab) {
    try { d = await api.tabs.sendMessage(tab.id, { type: 'diag' }, { frameId: 0 }); } catch (e) { /* no script */ }
  }
  const text = JSON.stringify({
    page: d?.page ?? tab?.url,
    extension: { version: s?.version, mode: s?.mode, backend: s?.backend, latency: s?.latency, settings: s?.settings },
    events: d?.events ?? [],
  });
  await navigator.clipboard.writeText(text);
  $('msg').textContent = d
    ? `Copied ${d.events.length} events from ${tab.title || tab.url}.`
    : 'No web page with Psalm101 activity found.';
});

(async () => {
  const t = await lastPage();
  if (t) $('diagTarget').textContent = `What happened to the images on "${t.title || t.url}", to share when something looks wrong.`;
})();
render();
setInterval(render, 2000);
