// Psalm101 content script: images stay invisible (content.css) until the local on-device model approves them, so a
// filtered image never paints.  Playing videos are buffered (or sampled) and hidden while a frame is flagged.
// Anything the extension can't read directly (cross-origin video without CORS, canvas, unverified CSS backgrounds)
// is checked via the tab-capture backstop.
(() => {
  'use strict';
  if (window.__psalm101) return;
  window.__psalm101 = true;
  const api = globalThis.browser ?? globalThis.chrome;
  const R = globalThis.PsalmRules;       // rules.js (loaded before this script)
  const scores = new WeakMap();          // element -> {p, m}: its check's probabilities (re-decided on a new level)
  // Every image URL already decided on this page.  Pages re-insert, clone and re-render the same images all the time
  // (carousels, lazy loaders); a known URL is decided on the spot, before the browser paints, so it never blinks.
  const known = new Map();               // absolute URL -> {block, p, m, unverified}
  let level = null;                      // the current level, once the background has announced one
  let videoEnabled = true;               // can be toggled off for slower devices
  const videoAudio = new WeakMap();      // video -> {delay, gain} (reused cleanly across toggles / fullscreen)
  const knownBlock = (v) => (v.unverified ? true : v.p && level != null ? R.decide(v.p, v.m, level) : !!v.block);
  function learn(url, res) {
    if (!url || url.startsWith('blob:') || res.offline || res.timeout) return;
    known.set(url, { block: !!res.block, p: res.p, m: res.m, unverified: !!res.unverified });
    if (known.size > 3000) known.delete(known.keys().next().value);
  }
  // Already decided: apply the known verdict now.  Returns false if the URL isn't known.
  function fromMemory(img, src) {
    const v = known.get(src);
    if (!v) return false;
    if (v.p) scores.set(img, { p: v.p, m: v.m });
    decide(img, src, knownBlock(v), v.unverified);
    return true;
  }
  // Diagnostics for the popup's "Copy page diagnostics": what happened to images on this page, most recent last.
  const t0 = performance.now(), diag = [];
  // Holding the old picture relies on content: url() replacing what an <img> paints (Chromium, Safari); elsewhere a
  // changing image is hidden until checked.
  const CAN_HOLD = !/Firefox\//.test(navigator.userAgent);
  function note(event, url, detail) {
    diag.push([Math.round(performance.now() - t0), event, String(url ?? '').slice(0, 160), detail ?? '']);
    if (diag.length > 400) diag.shift();
  }

  // Ahead-of-time checks: lazy loaders park the real address in attributes and swap it in later; checking those
  // early means the image is already known when it appears (no wait, no blink).
  const LAZY = ['data-src', 'data-lazy-src', 'data-original', 'data-old-hires', 'data-a-hires', 'data-hires', 'data-srcset', 'data-lazy-srcset'];
  const prechecked = new Set();
  function precheck(img) {
    if (prechecked.size > 400) return;
    const urls = [];
    for (const a of LAZY) {
      const v = img.getAttribute(a);
      if (v) for (const part of v.split(',')) urls.push(part.trim().split(/\s+/)[0]);
    }
    const dyn = img.getAttribute('data-a-dynamic-image');                 // {"url": [w, h], ...}
    if (dyn) { try { urls.push(...Object.keys(JSON.parse(dyn))); } catch (e) { /* not JSON */ } }
    for (const u of urls) {
      let abs;
      try { abs = new URL(u, document.baseURI).href; } catch (e) { continue; }
      if (!/^https?:/.test(abs) || known.has(abs) || prechecked.has(abs)) continue;
      prechecked.add(abs);
      send({ type: 'classify', url: abs, priority: 8000 }).then((res) => {
        if (res && !res.offline) { learn(abs, res); note('prechecked', abs, res.block ? 'flagged' : 'ok'); }
      });
    }
  }

  // The URLs a srcset could pick (resolved).
  const candidates = (img) => (img.srcset || '').split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean)
    .map((u) => { try { return new URL(u, document.baseURI).href; } catch (e) { return ''; } });
  const ATTR = 'data-psalm';            // images: "ok" | "blocked" | absent = hidden while being checked
  const VATTR = 'data-psalm-video';     // videos: "ok" | "blocked" | "overlay" | absent = hidden until first check
  const FRAME_GAP_MS = 100;             // at most ~10 frame checks per second per video
  const FRAME_SIZE = 256;
  const CLEAN_TO_SHOW = 2;              // a hidden video needs this many clean frames in a row to come back

  const send = async (msg) => {
    try { return await api.runtime.sendMessage(msg); } catch (e) { return null; }
  };

  // ---------- images ----------
  const inflight = new WeakMap();        // img -> source being checked
  const seenImg = new WeakSet();
  let blockedCount = 0;

  // After a src/srcset change, currentSrc keeps the *old* URL until the new request starts; that stale value must
  // never be judged in place of the new one.
  const stale = new WeakMap();
  const chosenLater = (img) => !!img.srcset || img.parentElement?.tagName === 'PICTURE';
  function srcOf(img) {
    if (!chosenLater(img)) return img.src || '';      // the src attribute is always current
    const s = img.currentSrc || '';
    return s && s === stale.get(img) ? '' : s;        // wait for the browser to pick the new source (load event)
  }

  function priority(el) {   // distance from the viewport (checked first when on screen)
    const r = el.getBoundingClientRect();
    if (r.bottom >= 0 && r.top <= innerHeight) return 0;
    return Math.min(Math.abs(r.top - innerHeight), Math.abs(r.bottom));
  }

  function decide(img, src, block, unverified = false) {
    const was = img.getAttribute(ATTR);
    img.dataset.psalmSrc = src;
    if (unverified) img.setAttribute('data-psalm-unverified', '');   // couldn't be checked: kept hidden
    else img.removeAttribute('data-psalm-unverified');
    if (!block && was !== 'ok' && was !== 'hold') {                 // it was hidden: fade in
      img.setAttribute('data-psalm-reveal', '');
      setTimeout(() => img.removeAttribute('data-psalm-reveal'), 150);
    }
    img.setAttribute(ATTR, block ? 'blocked' : 'ok');
    img.style.removeProperty('--psalm-hold');
    note(block ? 'hidden' : 'shown', src, was ?? 'new');
    if (block && was !== 'blocked') { blockedCount++; report(); }
    if (!block && was === 'blocked') { blockedCount--; report(); }
  }

  async function readBlob(url) {
    const b = await (await fetch(url)).blob();
    const buf = new Uint8Array(await b.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Can the page's own pixels be read?  Same-origin, data:/blob:, and CORS (crossorigin) images: yes.
  function pixelsReadable(img, src) {
    if (src.startsWith('data:') || src.startsWith('blob:')) return true;
    if (img.crossOrigin === 'anonymous' || img.crossOrigin === 'use-credentials') return true;
    try { return new URL(src, location.href).origin === location.origin; } catch (e) { return false; }
  }

  // Resolves when the image has loaded (true) or failed (false).
  function loaded(img) {
    return new Promise((resolve) => {
      if (img.complete) { resolve(img.naturalWidth > 0); return; }
      const done = (ok) => { img.removeEventListener('load', onLoad); img.removeEventListener('error', onError); resolve(ok); };
      const onLoad = () => done(true), onError = () => done(false);
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
    });
  }

  // A JPEG of exactly what the page decoded, or null if the browser won't let us read it (cross-origin, no CORS).
  function readPixels(img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    const s = Math.min(1, 1024 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    try {
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    } catch (e) { return null; }
  }

  // A cross-origin <img> can display an SVG while its canvas pixels remain unreadable, even when the server
  // permits CORS. Retry as a detached CORS image so the browser can rasterize it before the normal image check.
  // No verdict is bypassed: failed CORS/decoding stays unverified, and these pixels still go to the classifier.
  function readCorsPixels(src, referrerPolicy) {
    if (!/^https?:/.test(src)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const copy = new Image();
      copy.crossOrigin = 'anonymous';
      if (referrerPolicy) copy.referrerPolicy = referrerPolicy;
      const finish = (data) => {
        clearTimeout(timer);
        copy.onload = copy.onerror = null;
        copy.removeAttribute('src');
        resolve(data);
      };
      const timer = setTimeout(() => finish(null), 8000);
      copy.onload = () => finish(readPixels(copy));
      copy.onerror = () => finish(null);
      copy.src = src;
    });
  }

  // Decide one image.  Preferred: judge the pixels the page already has (no second download, which proxies and
  // CDNs may refuse or answer with something else).  Otherwise download it again in the extension.  If neither
  // works, the image stays hidden: an image that can't be checked isn't shown.
  async function check(img, attempt = 0) {
    const src = srcOf(img);
    if (!src) return;                                                        // nothing to show yet
    if (img.getAttribute(ATTR) && img.dataset.psalmSrc === src) return;      // already decided for this source
    if (inflight.get(img) === src) return;
    if (fromMemory(img, src)) { note('known', src); return; }               // seen on this page before
    note('checking', src);
    inflight.set(img, src);
    const current = () => inflight.get(img) === src && srcOf(img) === src;
    const pri = priority(img);
    let res = null, triedPixels = false;
    if (pixelsReadable(img, src)) {
      const ok = await loaded(img);
      if (!current()) return;
      if (!ok) { inflight.delete(img); decide(img, src, false); return; }   // broken image: nothing to show
      if (img.naturalWidth < 40 && img.naturalHeight < 40) { inflight.delete(img); decide(img, src, false); return; }
      const data = readPixels(img);
      triedPixels = true;
      if (data) res = await send({ type: 'classify', data, key: src, priority: pri });
    }
    if (!res || res.unverified) {
      if (src.startsWith('blob:')) {
        try { res = await send({ type: 'classify', data: await readBlob(src), key: src, priority: 0 }); } catch (e) { res = null; }
      } else if (!src.startsWith('data:')) {
        res = await send({ type: 'classify', url: src, priority: pri });
      }
    }
    if (res && res.unverified && !triedPixels) {          // the download failed: maybe the pixels are readable after all
      const ok = await loaded(img);
      if (!current()) { if (inflight.get(img) === src) { inflight.delete(img); check(img); } return; }
      if (!ok || (img.naturalWidth < 40 && img.naturalHeight < 40)) { inflight.delete(img); decide(img, src, false); return; }
      let data = readPixels(img);
      if (!data && current()) data = await readCorsPixels(src, img.referrerPolicy);
      if (data && current()) res = await send({ type: 'classify', data, key: src, priority: pri });
    }
    if (!current()) { if (inflight.get(img) === src) { inflight.delete(img); check(img); } return; }
    inflight.delete(img);
    if (!res || res.offline) {                             // the app isn't answering: stay hidden, try again
      setTimeout(() => check(img, attempt + 1), Math.min(30000, 2000 * 2 ** attempt));
      return;
    }
    if (res.p) scores.set(img, { p: res.p, m: res.m });
    learn(src, res);
    decide(img, src, !!res.block || !!res.unverified, !!res.unverified);
  }

  function watchImage(img) {
    if (!seenImg.has(img)) {
      seenImg.add(img);
      precheck(img);
      img.addEventListener('load', () => { stale.delete(img); check(img); });   // source known / changed (srcset, lazy)
    }
    check(img);
  }

  // ---------- video ----------
  const videos = new Map();              // video -> state
  let grabCanvas = document.createElement('canvas');
  let grabCtx = grabCanvas.getContext('2d', { willReadFrequently: false });

  function grab(v) {
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h || v.readyState < 2) return null;
    const s = FRAME_SIZE / Math.max(w, h);
    grabCanvas.width = Math.max(1, Math.round(w * s));
    grabCanvas.height = Math.max(1, Math.round(h * s));
    grabCtx.drawImage(v, 0, 0, grabCanvas.width, grabCanvas.height);
    try {
      return grabCanvas.toDataURL('image/jpeg', 0.85).split(',')[1];   // throws on cross-origin (tainted) video
    } catch (e) {
      // A tainted canvas stays permanently tainted; replace it so same-origin videos on the same page still work.
      grabCanvas = document.createElement('canvas');
      grabCtx = grabCanvas.getContext('2d', { willReadFrequently: false });
      throw e;
    }
  }

  // ---------- buffered video: nothing is shown before it has been checked ----------
  // The page's <video> keeps playing underneath an opaque canvas.  Every frame it presents is copied into a short
  // pre-buffer and shown `buffer` ms late.  Frames are checked at a steady pace (~5/s, plus immediately after seeks)
  // so the GPU isn't pegged on long videos, and a frame is shown only when the checks bracketing it are both clean.
  // A flagged check blacks out picture and sound (delayed in sync via Web Audio) from the last clean check until
  // HOLD_MS after the flagged frame.
  const BUFFER_MS = 400, CHECK_INTERVAL_MS = 200, HOLD_MS = 1000, MAX_WAIT_MS = 800, MAX_SIDE = 1600;
  let audioCtx = null;
  let small = document.createElement('canvas');

  function audioRunning(fromGesture = false) {
    try {
      if (!audioCtx) {
        if (!fromGesture && navigator.userActivation && !navigator.userActivation.hasBeenActive) return false;
        audioCtx = new AudioContext();
      }
      if (audioCtx.state !== 'running' && (fromGesture || !navigator.userActivation || navigator.userActivation.hasBeenActive)) {
        audioCtx.resume().catch(() => {});
      }
      return audioCtx.state === 'running';
    } catch (e) { return false; }
  }
  // Sound can only be delayed once the browser lets audio start (after a click or key press on the page).
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => { audioRunning(true); upgradeVideos(); }, true);

  const hasAudio = (v) => v.srcObject instanceof MediaStream ? v.srcObject.getAudioTracks().length > 0
    : (v.mozHasAudio ?? (v.webkitAudioDecodedByteCount === undefined || v.webkitAudioDecodedByteCount > 0 || v.readyState < 3));

  class Buffered {
    constructor(v) {
      this.v = v;
      this.frames = [];          // {bmp, dx, dy, dw, dh, wall, verdict: undefined | 'ok' | 'block'}
      this.blackouts = [];       // [fromWall, toWall]
      this.busy = false;
      this.gen = 0;              // bumped on every seek
      this.buffer = BUFFER_MS;   // adapts smoothly up to 1.4 s on slower devices
      this.lastCheck = 0;        // 0 = check immediately (startup / post-seek)
      this.paceTimer = 0;
      this.samples = [];         // recent check times (ms)
      this.checksDone = 0;
      this.dark = null;          // what the canvas shows: true = black, false = a frame, null = nothing yet
      this.dead = false;
      this.mutedByUs = false;
      this.canvas = document.createElement('canvas');
      this.canvas.setAttribute('data-psalm-buffer', '');
      Object.assign(this.canvas.style, { position: 'absolute', pointerEvents: 'none', background: '#000',
                                          margin: '0', padding: '0', border: '0', boxSizing: 'border-box' });
      this.g = this.canvas.getContext('2d');
      this.place();
      this.black();
      this.routeAudio();
      v.dataset.psalmBuffer = String(this.buffer);
      v.setAttribute(VATTR, 'buffered');   // the video shows again, but only under the canvas
      this.onFrame = this.onFrame.bind(this);
      this.tick = this.tick.bind(this);
      v.requestVideoFrameCallback(this.onFrame);
      requestAnimationFrame(this.tick);
      this.onSeek = () => this.reset();
      v.addEventListener('seeking', this.onSeek);
      v.addEventListener('emptied', this.onSeek);
    }

    routeAudio() {
      this.gain = null;
      this.delay = null;
      if (!hasAudio(this.v)) return;
      try {
        let node = videoAudio.get(this.v);
        if (!node) {
          const src = this.v.srcObject instanceof MediaStream ? audioCtx.createMediaStreamSource(this.v.srcObject)
                                                               : audioCtx.createMediaElementSource(this.v);
          const delay = audioCtx.createDelay(2);
          const gain = audioCtx.createGain();
          src.connect(delay).connect(gain).connect(audioCtx.destination);
          node = { delay, gain };
          videoAudio.set(this.v, node);
        }
        node.delay.delayTime.setTargetAtTime(this.buffer / 1000, audioCtx.currentTime, 0.01);
        this.delay = node.delay;
        this.gain = node.gain;
        if (this.v.srcObject instanceof MediaStream) this.v.muted = true;   // the graph plays it instead
      } catch (e) { this.gain = null; this.delay = null; }    // the page already routes its audio: fall back to muting
    }

    sound(on) {
      this.v.dataset.psalmSound = on ? 'on' : 'off';
      if (this.gain) this.gain.gain.setTargetAtTime(on ? 1 : 0, audioCtx.currentTime, 0.005);
      else if (!on && !this.v.muted) { this.v.muted = true; this.mutedByUs = true; }
      else if (on && this.mutedByUs) { this.v.muted = false; this.mutedByUs = false; }
    }

    place() {
      const v = this.v, c = this.canvas;
      if (c.parentNode !== v.parentNode || c.previousSibling !== v) v.after(c);
      const cs = getComputedStyle(v);
      c.style.left = v.offsetLeft + 'px';
      c.style.top = v.offsetTop + 'px';
      c.style.width = v.offsetWidth + 'px';
      c.style.height = v.offsetHeight + 'px';
      c.style.zIndex = cs.zIndex;
      c.style.display = cs.display === 'none' || cs.visibility === 'hidden' ? 'none' : 'block';
      const dpr = Math.min(devicePixelRatio || 1, 1.5), s = Math.min(1, MAX_SIDE / Math.max(1, v.offsetWidth * dpr));
      const w = Math.max(1, Math.round(v.offsetWidth * dpr * s)), h = Math.max(1, Math.round(v.offsetHeight * dpr * s));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; this.dark = null; }
    }

    black() {
      this.g.fillStyle = '#000';
      this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    // Where the video's picture sits in the canvas (object-fit contain / cover / fill).
    fit() {
      const v = this.v, cw = this.canvas.width, ch = this.canvas.height, vw = v.videoWidth, vh = v.videoHeight;
      const mode = getComputedStyle(v).objectFit;
      if (mode === 'fill') return [0, 0, cw, ch];
      const s = mode === 'cover' ? Math.max(cw / vw, ch / vh) : Math.min(cw / vw, ch / vh);
      const dw = Math.round(vw * s), dh = Math.round(vh * s);
      return [Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), dw, dh];
    }

    onFrame(now) {
      if (this.dead) return;
      const v = this.v;
      if (v.videoWidth && v.videoHeight) {
        const [dx, dy, dw, dh] = this.fit();
        createImageBitmap(v, { resizeWidth: Math.max(1, dw), resizeHeight: Math.max(1, dh), resizeQuality: 'medium' })
          .then((bmp) => {
            if (this.dead) { bmp.close(); return; }
            const f = { bmp, dx, dy, dw, dh, wall: now, verdict: undefined };
            let i = this.frames.length;
            while (i > 0 && this.frames[i - 1].wall > now) i--;
            this.frames.splice(i, 0, f);
            this.checkNewest();
          })
          .catch((e) => {
            if (e?.name === 'SecurityError') this.fallbackToOverlay();
          });
      }
      v.requestVideoFrameCallback(this.onFrame);
    }

    // Check the newest unchecked frame at a steady pace (~5/s; immediately on start/seek) so long videos don't peg
    // the GPU, while a trailing timer ensures the final frame before a pause or network stall is still checked.
    async checkNewest() {
      if (this.dead || this.busy) return;
      const f = this.frames[this.frames.length - 1];
      if (!f || f.verdict !== undefined) return;
      const wait = this.lastCheck ? CHECK_INTERVAL_MS - (performance.now() - this.lastCheck) : 0;
      if (wait > 5) {
        if (!this.paceTimer) {
          this.paceTimer = setTimeout(() => { this.paceTimer = 0; this.checkNewest(); }, wait);
        }
        return;
      }
      clearTimeout(this.paceTimer);
      this.paceTimer = 0;
      this.busy = true;
      this.lastCheck = performance.now();
      f.pending = true;
      const gen = this.gen;
      let data;
      try {
        const s = FRAME_SIZE / Math.max(f.bmp.width, f.bmp.height);
        small.width = Math.max(1, Math.round(f.bmp.width * s));
        small.height = Math.max(1, Math.round(f.bmp.height * s));
        small.getContext('2d').drawImage(f.bmp, 0, 0, small.width, small.height);
        data = small.toDataURL('image/jpeg', 0.85).split(',')[1];
      } catch (e) {
        small = document.createElement('canvas');
        f.pending = false;
        this.busy = false;
        if (e?.name === 'SecurityError') this.fallbackToOverlay();
        return;
      }
      const t0 = performance.now();
      const res = await send({ type: 'frame', data });
      f.pending = false;
      const elapsed = performance.now() - t0;
      if (res && !res.offline && !res.timeout) this.adapt(elapsed);
      if (f.pruned) f.bmp.close();
      if (gen !== this.gen) return;            // a seek happened meanwhile: this answer is about the old position
      this.busy = false;
      if (!res || res.timeout || res.offline) {
        // Transient timeout or service-worker wake-up: retry promptly without injecting a 1 s content blackout.
        this.lastCheck = 0;
        if (!this.dead) {
          this.paceTimer = setTimeout(() => { this.paceTimer = 0; this.checkNewest(); }, res?.timeout ? 20 : 150);
        }
        return;
      }
      f.verdict = res.block ? 'block' : 'ok';
      if (f.verdict === 'block') {
        const prev = this.frames.filter((x) => x.wall < f.wall && x.verdict === 'ok').pop();
        this.blackouts.push([prev ? prev.wall : f.wall - this.buffer, f.wall + HOLD_MS]);
        note('video-blocked', location.href, res.p ? `p=${res.p.map((x) => x.toFixed(2)).join(',')}` : '');
      }
      if (!this.dead) this.checkNewest();
    }

    // Keep the pre-buffer deep enough to absorb latency spikes (p90 check time + check interval + margin, up to 1.4 s)
    // so playback stays smooth without blanking out; re-tuned (also down) on seek.
    wanted() {
      if (this.samples.length < 4) return null;
      const s = [...this.samples].sort((a, b) => a - b);
      const p90 = s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
      return Math.max(BUFFER_MS, Math.min(1400, Math.round(CHECK_INTERVAL_MS + 2 * p90 + 100)));
    }
    setBuffer(ms) {
      this.buffer = ms;
      if (this.delay) this.delay.delayTime.setTargetAtTime(ms / 1000, audioCtx.currentTime, 0.02);
      this.v.dataset.psalmBuffer = String(ms);
    }
    adapt(ms) {
      if (++this.checksDone <= 2) return;
      this.samples.push(ms);
      if (this.samples.length > 20) this.samples.shift();
      const want = this.wanted();
      if (want && want > this.buffer + 40) this.setBuffer(want);
    }

    decide(i) {
      const f = this.frames[i];
      if (this.blackouts.some(([a, b]) => f.wall > a && f.wall <= b)) return 'black';
      let prev = null, next = null;
      for (let k = i; k >= 0; k--) if (this.frames[k].verdict !== undefined) { prev = this.frames[k]; break; }
      for (let k = i; k < this.frames.length; k++) if (this.frames[k].verdict !== undefined) { next = this.frames[k]; break; }
      if (!next) return 'wait';
      return next.verdict === 'ok' && (!prev || prev.verdict === 'ok') ? 'show' : 'black';
    }

    tick() {
      if (this.dead) return;
      if (!this.v.isConnected) { this.stop(); return; }
      this.place();
      const now = performance.now();
      let i = -1;
      for (let k = this.frames.length - 1; k >= 0; k--) if (now - this.frames[k].wall >= this.buffer) { i = k; break; }
      if (i >= 0) {
        const f = this.frames[i];
        let d = this.decide(i);
        // When the video itself is paused or network-buffering, hold the last clean frame rather than blacking out.
        const stalling = this.v.paused || this.v.readyState < 3;
        if (d === 'wait' && !stalling && now - f.wall > this.buffer + MAX_WAIT_MS) {
          d = 'black';
          this.v.dataset.psalmReason = 'late';
          note('video-black', location.href, `late verdict (${Math.round(now - f.wall)} ms, buf ${this.buffer})`);
        }
        if (d === 'show') {
          this.v.dataset.psalmReason = 'ok';
          if (this.dark !== false || this.shownFrame !== f) {
            this.black();
            this.g.drawImage(f.bmp, f.dx, f.dy, f.dw, f.dh);
            this.shownFrame = f;
          }
          if (this.dark !== false) { this.sound(true); if (this.dark === true) { blockedCount = Math.max(0, blockedCount - 1); report(); } }
          this.dark = false;
        } else if (d === 'black') {
          if (this.v.dataset.psalmReason !== 'late' && this.v.dataset.psalmReason !== 'seek') this.v.dataset.psalmReason = 'blocked';
          if (this.dark !== true) {
            this.black();
            this.sound(false);
            blockedCount++;
            report();
          }
          this.dark = true;
        }
        // Keep the displayed frame, the last checked frame before it, and any in-flight pending frame.
        let keep = i;
        for (let k = i; k >= 0; k--) if (this.frames[k].verdict !== undefined) { keep = k; break; }
        const pendingIdx = this.frames.findIndex((x) => x.pending);
        if (pendingIdx >= 0 && pendingIdx < keep) keep = pendingIdx;
        const old = this.frames.splice(0, keep);
        for (const o of old) { if (o.pending) o.pruned = true; else o.bmp.close(); }
        this.blackouts = this.blackouts.filter(([, b]) => b > now - 5000);
      }
      requestAnimationFrame(this.tick);
    }

    reset() {   // seek or new source: start over, black until new frames are checked
      const want = this.wanted();
      if (want && want !== this.buffer) this.setBuffer(want);
      clearTimeout(this.paceTimer);
      this.paceTimer = 0;
      this.lastCheck = 0;        // check the first frame at the new position immediately
      this.gen++;                // answers about the old position are ignored
      this.busy = false;
      for (const f of this.frames) { if (f.pending) f.pruned = true; else f.bmp.close(); }
      this.frames = [];
      this.blackouts = [];
      this.v.dataset.psalmReason = 'seek';
      this.black();
      if (this.dark !== true) { this.sound(false); blockedCount++; report(); }
      this.dark = true;
    }

    // Cross-origin video whose pixels became unreadable (e.g. src switched to a cross-origin CDN):
    // release the opaque buffer canvas and let the tab-capture backstop monitor it.
    fallbackToOverlay() {
      if (this.dead) return;
      const v = this.v, st = videos.get(v);
      this.stop(false);
      if (st) { st.buffer = null; st.mode = 'overlay'; st.readable = false; }
      v.setAttribute(VATTR, 'overlay');
      scheduleSweep(100);
    }

    // Stop buffering this video (removed, video filtering turned off, or entered native fullscreen).
    stop(forget = true) {
      this.dead = true;
      clearTimeout(this.paceTimer);
      this.paceTimer = 0;
      this.gen++;
      for (const f of this.frames) { if (f.pending) f.pruned = true; else f.bmp.close(); }
      this.frames = [];
      this.blackouts = [];
      if (this.delay && audioCtx) this.delay.delayTime.setTargetAtTime(0, audioCtx.currentTime, 0.01);
      this.sound(true);
      if (this.dark === true) { blockedCount = Math.max(0, blockedCount - 1); report(); }
      this.dark = null;
      this.canvas.remove();
      this.v.removeEventListener('seeking', this.onSeek);
      this.v.removeEventListener('emptied', this.onSeek);
      if (forget) videos.delete(this.v);
    }
  }

  // Switch a readable, visible video to buffered playback when possible (pixels proven readable, frame callbacks
  // available, and its sound can be delayed or it has none).  Otherwise it stays in sampling mode.
  function tryBuffer(v) {
    const st = videos.get(v);
    if (!st || st.mode !== 'sample' || !st.readable || !v.requestVideoFrameCallback || !window.createImageBitmap) return false;
    if (v.offsetWidth < 120 || v.offsetHeight < 68) return false;
    if (document.fullscreenElement === v) return false;      // nothing can be drawn over a video that is itself fullscreen
    if (hasAudio(v) && !audioRunning()) return false;        // can't delay its sound yet; retried after a click
    st.mode = 'buffered';
    st.buffer = new Buffered(v);
    return true;
  }
  // A <video> that goes fullscreen itself can't be drawn over: sample it (hide + mute on a finding) until it's back.
  document.addEventListener('fullscreenchange', () => {
    for (const [v, st] of videos) {
      if (st.mode === 'buffered' && document.fullscreenElement === v) {
        st.buffer.stop(false);
        st.buffer = null;
        st.mode = 'sample';
        st.last = -1e9;
        v.removeAttribute(VATTR);          // hidden until the sampler's first verdict
        videoLoop(v);
      }
    }
    if (!document.fullscreenElement) upgradeVideos();
  });

  function upgradeVideos() { for (const [v, st] of videos) if (st.mode === 'sample' && v.getAttribute(VATTR) !== 'overlay') tryBuffer(v); }

  // ---------- sampling (fallback): small videos, before a click allows delayed sound, fullscreen video ----------
  async function sampleVideo(v) {
    const st = videos.get(v);
    if (!st || st.busy || st.mode !== 'sample') return;
    const now = performance.now();
    if (now - st.last < FRAME_GAP_MS) return;
    let data;
    try { data = grab(v); } catch (e) {
      // Can't read its pixels: the backstop (tab capture) handles this video.
      st.mode = 'overlay';
      st.readable = false;
      v.setAttribute(VATTR, 'overlay');
      scheduleSweep(100);
      return;
    }
    if (data) {
      st.readable = true;
      if (tryBuffer(v)) return;
    }
    if (!data) {
      if (v.poster && !v.getAttribute(VATTR)) {           // not playing yet: judge the poster image
        st.busy = true;
        const res = await send({ type: 'classify', url: v.poster, priority: 0 });
        st.busy = false;
        if (res && !res.offline && !v.getAttribute(VATTR)) v.setAttribute(VATTR, res.block ? 'blocked' : 'ok');
      }
      return;
    }
    st.busy = true;
    st.last = now;
    const res = await send({ type: 'frame', data });
    st.busy = false;
    if (st.mode !== 'sample' || !res || res.offline || res.timeout) return;   // stays as is (hidden until a first verdict)
    if (res.block) {
      st.clean = 0;
      if (v.getAttribute(VATTR) !== 'blocked') { v.setAttribute(VATTR, 'blocked'); blockedCount++; report(); }
      if (!v.muted) { v.muted = true; st.mutedByUs = true; }       // mute on detection
    } else {
      st.clean++;
      const cur = v.getAttribute(VATTR);
      if (!cur) v.setAttribute(VATTR, 'ok');
      else if (cur === 'blocked' && st.clean >= CLEAN_TO_SHOW) {
        v.setAttribute(VATTR, 'ok');
        blockedCount--;
        report();
        if (st.mutedByUs) { v.muted = false; st.mutedByUs = false; }
      }
    }
  }

  function videoLoop(v) {
    const st = videos.get(v);
    if (!st || !v.isConnected) { if (st?.buffer) st.buffer.stop(); videos.delete(v); return; }
    if (st.mode !== 'sample') return;
    sampleVideo(v);
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => videoLoop(v));
    else setTimeout(() => videoLoop(v), FRAME_GAP_MS);
  }

  function watchVideo(v) {
    if (!videoEnabled || videos.has(v)) return;
    videos.set(v, { busy: false, last: -1e9, clean: 0, mode: 'sample', readable: false });
    const kick = () => { const st = videos.get(v); if (st && st.mode === 'sample') { st.last = -1e9; sampleVideo(v); } };
    v.addEventListener('loadeddata', kick);
    v.addEventListener('canplay', kick);
    v.addEventListener('seeked', kick);
    v.addEventListener('play', kick);
    // A src change starts over: hidden until its first frame is checked (buffered videos handle this themselves).
    v.addEventListener('emptied', () => { const st = videos.get(v); if (st && st.mode === 'sample') { st.readable = false; v.removeAttribute(VATTR); } });
    videoLoop(v);
    kick();
    // Watchdog: frame callbacks pause in some cases (e.g. off screen); keep sampling a playing video regardless.
    const timer = setInterval(() => {
      const st = videos.get(v);
      if (!videoEnabled || !st || !v.isConnected || st.mode !== 'sample') { clearInterval(timer); return; }
      if (!v.paused && performance.now() - st.last > 300) sampleVideo(v);
    }, 300);
  }

  function setVideoEnabled(on) {
    const next = on !== false;
    if (next === videoEnabled) return;
    videoEnabled = next;
    if (!next) {
      document.documentElement.setAttribute('data-psalm-no-video', '');
      for (const [v, st] of [...videos.entries()]) {
        if (st.buffer) st.buffer.stop(true);
        else {
          if (v.getAttribute(VATTR) === 'blocked') blockedCount = Math.max(0, blockedCount - 1);
          if (st.mutedByUs) { v.muted = false; st.mutedByUs = false; }
          videos.delete(v);
        }
        if (v.getAttribute('data-psalm-sweep') === 'blocked') {
          v.removeAttribute('data-psalm-sweep');
          blockedCount = Math.max(0, blockedCount - 1);
        }
        v.removeAttribute(VATTR);
        delete v.dataset.psalmBuffer;
        delete v.dataset.psalmSound;
        delete v.dataset.psalmReason;
      }
      report();
    } else {
      document.documentElement.removeAttribute('data-psalm-no-video');
      document.querySelectorAll('video').forEach(watchVideo);
    }
  }

  // ---------- discovery ----------
  function scan(node) {
    if (!node || (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11)) return;
    if (node.tagName === 'IMG' || (node.tagName === 'INPUT' && node.type === 'image')) watchImage(node);
    else if (node.tagName === 'VIDEO') watchVideo(node);
    if (node.querySelectorAll) {
      node.querySelectorAll('img, input[type="image"]').forEach(watchImage);
      node.querySelectorAll('video').forEach(watchVideo);
    }
  }

  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const el = m.target;
        if (el.tagName === 'IMG' || el.tagName === 'INPUT') {
          if (el.getAttribute(m.attributeName) === m.oldValue) continue;      // written with the same value
          if (el.getAttribute(ATTR)) {
            // A new src that's already decided (or the same image again): no need to hide it at all.
            if (m.attributeName === 'src' && !chosenLater(el) && (el.src === el.dataset.psalmSrc || fromMemory(el, el.src))) continue;
            // A new srcset whose every possible pick is already known safe: whichever the browser picks is fine.
            if (m.attributeName !== 'src') {
              const c = candidates(el);
              if (c.length && c.every((u) => known.has(u) && !knownBlock(known.get(u)))) continue;
            }
          }
          const oldCurrent = el.currentSrc;
          if (oldCurrent) stale.set(el, oldCurrent);
          const prev = el.dataset.psalmSrc, state = el.getAttribute(ATTR);
          if (CAN_HOLD && ((state === 'ok' && prev) || state === 'hold')) {
            // Shown and approved: keep drawing the approved picture until the newest one is checked (no blink).
            // Already holding (several changes in a row): keep the same approved picture.
            if (state === 'ok') {
              el.style.setProperty('--psalm-hold', `url("${prev.replace(/["\\\n]/g, encodeURIComponent)}")`);
              el.setAttribute(ATTR, 'hold');
            }
            note('holding', el.getAttribute('src'), `${m.attributeName} changed; approved picture kept`);
          } else {
            el.removeAttribute(ATTR);                       // new source: hidden again before it can paint
            note('hiding', el.getAttribute('src'), `${m.attributeName} changed`);
          }
          delete el.dataset.psalmSrc;
          inflight.delete(el);
          check(el);
          // Inside <picture> / srcset, changing an attribute may still resolve to the exact same currentSrc,
          // so no new `load` event ever fires.  If it stays settled on that URL, clear `stale` and re-check.
          if (oldCurrent && chosenLater(el)) {
            requestAnimationFrame(() => {
              if (stale.get(el) === oldCurrent && el.complete && el.naturalWidth > 0 && el.currentSrc === oldCurrent) {
                stale.delete(el);
                check(el);
              }
            });
          }
        }
        continue;
      }
      m.addedNodes.forEach(scan);
      if (m.addedNodes.length) scheduleSweep(500);
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['src', 'srcset', 'sizes'] });
  scan(document);

  // ---------- a new filtering level: re-decide everything already checked, at once ----------
  // (Images that couldn't be checked stay hidden; things the tab-capture backstop hid stay hidden until reload.)
  function redecide(level) {
    let changed = 0;
    for (const el of document.querySelectorAll('img[data-psalm], input[type="image"][data-psalm], [data-psalm-bg]')) {
      const v = scores.get(el);
      if (!v || el.hasAttribute('data-psalm-unverified') || el.getAttribute(ATTR) === 'hold') continue;
      const block = R.decide(v.p, v.m, level);
      const attr = el.hasAttribute('data-psalm-bg') ? 'data-psalm-bg' : ATTR;
      const was = el.getAttribute(attr) === 'blocked';
      if (block === was) continue;
      el.setAttribute(attr, block ? 'blocked' : 'ok');
      blockedCount += block ? 1 : -1;
      changed++;
    }
    if (changed) report();
  }
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'policy') {
      if (msg.level != null) { level = msg.level; redecide(msg.level); }
      if ('video' in msg) setVideoEnabled(msg.video);
    }
    if (msg?.type === 'diag' && window === window.top) { sendResponse({ page: location.href, events: diag }); }
    return false;
  });
  send({ type: 'policy' }).then((p) => {
    if (!p) return;
    if (p.level != null) level = p.level;
    if (p.video === false) setVideoEnabled(false);
  });

  // ---------- reporting ----------
  let reportTimer = 0;
  function report() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => send({ type: 'count', blocked: Math.max(0, blockedCount) }), 200);
  }

  // ---------- CSS background images ----------
  // These can't be held back before they paint (CSS can't select by computed background), so they're found as they
  // come into view and checked by URL like images; a flagged one loses its background image (text on it stays).
  const bgSeen = new WeakMap();          // element -> background URL decided or being checked
  function bgUrl(el) {
    const b = getComputedStyle(el).backgroundImage;
    if (!b || b === 'none' || !b.includes('url(')) return null;
    const m = b.match(/url\(["']?(.*?)["']?\)/);
    return m && m[1] ? new URL(m[1], document.baseURI).href : null;
  }
  async function checkBg(el, url) {
    bgSeen.set(el, url);
    const res = await send({ type: 'classify', url, priority: priority(el) });
    if (bgSeen.get(el) !== url) return;
    if (!res || res.offline) { bgSeen.delete(el); return; }      // try again on the next scan
    if (res.p) scores.set(el, { p: res.p, m: res.m });
    if (res.block) { el.setAttribute('data-psalm-bg', 'blocked'); blockedCount++; report(); }
    else el.setAttribute('data-psalm-bg', res.unverified ? 'unverified' : 'ok');
  }
  function scanBackgrounds() {
    if (!document.body) return;
    const below = innerHeight * 2;     // what's on screen and the next screenful
    for (const el of document.body.getElementsByTagName('*')) {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40 || r.bottom < 0 || r.top > below || r.right < 0 || r.left > innerWidth) continue;
      const u = bgUrl(el);
      if (u && bgSeen.get(el) !== u) checkBg(el, u);
    }
  }

  // ---------- backstop: what the extension can't read ----------
  // About once a second after the page changes, the visible tab is captured and the app checks what the extension
  // couldn't (canvas, video it can't read, images it couldn't download) plus anything else that looks like media
  // there.  Flagged things are hidden as page elements, so they scroll with the page.
  let lastSweep = -1e9, sweepTimer = 0;
  function scheduleSweep(delay = 300) {
    if (window !== window.top) return;
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweep, delay);
  }
  const onScreen = (r) => r.width >= 40 && r.height >= 40 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  const box = (r) => [r.left, r.top, r.width, r.height];

  async function sweep() {
    if (document.visibilityState !== 'visible') return;
    const wait = 1200 - (performance.now() - lastSweep);
    if (wait > 0) { sweepTimer = setTimeout(sweep, wait); return; }
    lastSweep = performance.now();
    scanBackgrounds();
    const masks = [], cands = [], els = [];
    const add = (el, candidate) => {
      const r = el.getBoundingClientRect();
      if (!onScreen(r)) return;
      if (candidate) { cands.push(box(r)); els.push(el); } else masks.push(box(r));
    };
    for (const img of document.querySelectorAll('img[data-psalm="ok"]')) add(img, img.hasAttribute('data-psalm-unverified'));
    if (videoEnabled) {
      for (const v of document.querySelectorAll('video')) {
        const a = v.getAttribute(VATTR);
        if (a === 'ok') add(v, false); else if (a === 'overlay') add(v, true);
      }
    }
    for (const c of document.querySelectorAll('canvas:not([data-psalm-sweep]):not([data-psalm-buffer])')) add(c, true);
    for (const el of document.querySelectorAll('[data-psalm-bg="ok"]')) add(el, false);
    for (const el of document.querySelectorAll('[data-psalm-bg="unverified"]')) add(el, true);
    const res = await send({ type: 'sweep', viewport: [innerWidth, innerHeight], masks, candidates: cands });
    if (!res || res.offline) return;
    for (const i of res.flagged ?? []) hideElement(els[i]);
    for (const [x, y, w, h] of res.found ?? []) {
      // Media the page doesn't expose as an image: hide the element that best matches the flagged area.
      let best = null, bestIoU = 0.3;
      for (const el of document.elementsFromPoint(x + w / 2, y + h / 2)) {
        if (el === document.documentElement || el === document.body) continue;
        const r = el.getBoundingClientRect();
        const ix = Math.max(0, Math.min(r.right, x + w) - Math.max(r.left, x)), iy = Math.max(0, Math.min(r.bottom, y + h) - Math.max(r.top, y));
        const iou = (ix * iy) / (r.width * r.height + w * h - ix * iy);
        if (iou > bestIoU) { best = el; bestIoU = iou; }
      }
      if (best) hideElement(best);
    }
    // Video the extension can't read is only covered by this backstop: keep looking while it plays.
    if (videoEnabled && [...document.querySelectorAll('video[data-psalm-video="overlay"]')].some((v) => !v.paused)) scheduleSweep(1200);
  }

  function hideElement(el) {
    if (!el || el.getAttribute('data-psalm-sweep') === 'blocked') return;
    el.setAttribute('data-psalm-sweep', 'blocked');
    blockedCount++;
    report();
  }

  // Reset this tab's hidden count on each new top-level document and schedule backstop sweeps on page changes.
  if (window === window.top) {
    send({ type: 'count', blocked: 0, reset: true });
    document.addEventListener('visibilitychange', () => scheduleSweep(300));
    addEventListener('scroll', () => scheduleSweep(300), { passive: true });
    addEventListener('resize', () => scheduleSweep(300), { passive: true });
    addEventListener('load', () => scheduleSweep(100));
    document.addEventListener('DOMContentLoaded', () => scheduleSweep(100));
  } else {
    // Frames scan their own background images (the top frame's backstop sees frames only as a whole).
    const bg = () => setTimeout(scanBackgrounds, 300);
    addEventListener('load', bg);
    addEventListener('scroll', bg, { passive: true });
  }
})();
