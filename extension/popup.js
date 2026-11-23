// Psalm101 popup: focused on-device filtering level control and live page status.
const api = globalThis.browser ?? globalThis.chrome;
const { LEVELS, LEVEL_DETAIL } = globalThis.PsalmRules;
const $ = (id) => document.getElementById(id);
const send = (m) => api.runtime.sendMessage(m);
const BACKEND = {
  webgpu: 'GPU (WebGPU)',
  wasm: 'CPU (WebAssembly)',
  'webnn-npu': 'Neural Engine (WebNN)',
  'webnn-gpu': 'GPU (WebNN)',
};

let tabId = null, state = null, lastLevel = null;

function showLevel(v) {
  $('levelName').textContent = LEVELS[v];
  $('levelDetail').textContent = LEVEL_DETAIL[v];
  $('fill').style.width = `${(v / 3) * 100}%`;
  const bars = 4 - v;   // Very strict = 4/4 bars, Relaxed = 1/4 bar
  [...$('strength').children].forEach((el, i) => el.classList.toggle('on', i < bars));
  for (const b of $('ticks').children) b.classList.toggle('on', Number(b.dataset.v) === v);
}

async function setSetting(key, value) {
  const r = await send({ type: 'set', key, value });
  if (r?.error === 'locked') {
    $('unlock').hidden = false;
    $('pwErr').hidden = true;
    $('pw').focus();
  }
  refresh();
}

async function refresh() {
  const s = await send({ type: 'brief', tabId });
  if (!s) return;
  state = s;
  const levelOff = s.locked || s.managed.includes('level');
  const videoOff = s.locked || s.managed.includes('video');
  document.body.classList.toggle('locked', s.locked);

  if (document.activeElement !== $('level')) {
    $('level').value = s.level;
    showLevel(s.level);
  }
  $('level').disabled = levelOff;
  for (const b of $('ticks').children) b.disabled = levelOff;

  $('video').checked = s.video !== false;
  $('video').disabled = videoOff;
  $('videoSub').textContent = s.video !== false ? 'Checks playing video frames' : 'Off — filtering images only';

  // Status pill
  const pill = $('statusPill');
  const text = $('statusText');
  if (s.mode === 'offline') {
    pill.className = 'pill warn';
    text.textContent = 'Offline';
    pill.title = 'Local filter engine is not available';
  } else if (s.ready) {
    pill.className = 'pill good';
    text.textContent = 'On device';
    pill.title = `Checking locally on ${BACKEND[s.backend] ?? s.backend ?? 'this device'}`;
  } else {
    pill.className = 'pill';
    text.textContent = 'Starting…';
    pill.title = 'Preparing the on-device model';
  }

  // Footer
  const hiddenEl = $('hidden');
  hiddenEl.textContent = s.hidden ? `${s.hidden} hidden on this page` : 'Page is clear';
  hiddenEl.classList.toggle('active', s.hidden > 0);
  $('lock').hidden = !s.hasPassword || s.managed.includes('passwordHash');
  $('lock').classList.toggle('open', !s.locked);
  $('lock').title = s.locked ? 'Unlock settings' : 'Lock settings';
  if (!s.locked) { $('unlock').hidden = true; $('pwErr').hidden = true; }
}

$('level').addEventListener('input', () => {
  const v = Number($('level').value);
  showLevel(v);
  if (v !== lastLevel) { lastLevel = v; setSetting('level', v); }
});
for (const b of $('ticks').children) {
  b.addEventListener('click', () => {
    $('level').value = b.dataset.v;
    $('level').dispatchEvent(new Event('input'));
  });
}
$('video').addEventListener('change', () => setSetting('video', $('video').checked));

$('lock').addEventListener('click', async () => {
  if (state?.locked) {
    $('unlock').hidden = false;
    $('pwErr').hidden = true;
    $('pw').focus();
    return;
  }
  await send({ type: 'lock' });
  refresh();
});

const unlock = async () => {
  const r = await send({ type: 'unlock', password: $('pw').value });
  $('pw').value = '';
  if (r?.error) {
    $('pwErr').hidden = false;
    $('pw').focus();
    return;
  }
  $('unlock').hidden = true;
  $('pwErr').hidden = true;
  refresh();
};
$('unlockGo').addEventListener('click', unlock);
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
$('details').addEventListener('click', (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
  window.close();
});

api.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
  tabId = t?.id ?? null;
  refresh();
});
setInterval(refresh, 2000);
