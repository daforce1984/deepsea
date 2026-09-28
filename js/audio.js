// WebAudio: layered depth ambiences, breathing loop, positional one-shots, underwater low-pass. Stops when hidden.
const FILES = ['amb_shallow', 'amb_deep', 'amb_abyss', 'surface_waves', 'breath_mask', 'breath_scuba', 'bubbles_loop', 'splash_dive', 'torch_click',
  'whoosh_deep', 'whoosh_move', 'sonar', 'whale_low', 'whale_creepy', 'hud_beep', 'hud_scan', 'rumble', 'creature_move',
  'dolphin_click', 'dolphin_chitter', 'dolphin_noise', 'dolphin_call', 'dolphins_talk',
  'humpback_call', 'humpback_song', 'humpback_haunt', 'humpback_dive', 'humpback_baleines', 'entry_splash', 'entry_under', 'slap_big', 'slap_rock', 'dolphin_out_1', 'dolphin_out_2', 'dolphin_out_3', 'dolphin_in_1', 'dolphin_in_2', 'dolphin_in_3'];

// ---- rain of spray: every landing drop is a grain synthesised on the audio thread ----
// grain = 1-2 ms broadband impact tick + the trapped bubble's Minnaert 'plink' (a sine chirping upward as the bubble
// is pinched off, 10-30 ms).  Fixed 512-voice pool, no allocation in process(); the main thread posts one small
// Float32Array per frame: [pan, gain, size, delay] per drop.
const DROPS_WORKLET = `
// rain of spray: each landing drop = one grain cut from real recordings of drops falling into water.
// Fixed 384-voice pool, O(1) round-robin allocation, no allocation in process(); grains are read from one shared
// sample bank (sent once), pitch by drop size (big drops -> the deeper 'plop' recordings, played lower).
class Drops extends AudioWorkletProcessor {
  constructor() {
    super();
    const V = 384; this.V = V; this.next = 0;
    this.g = new Int32Array(V); this.pos = new Float32Array(V); this.rate = new Float32Array(V);
    this.gl = new Float32Array(V); this.gr = new Float32Array(V); this.wait = new Int32Array(V); this.live = new Uint8Array(V);
    this.bank = null; this.st = null; this.len = null; this.nG = 0; this.seed = 1234567; this.stats = { n: 0, steal: 0 };
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.bank) { this.bank = d.bank; this.st = d.st; this.len = d.len; this.nG = d.st.length; return; }
      if (!this.nG) return;
      for (let i = 0; i < d.length; i += 4) this.spawn(d[i], d[i + 1], d[i + 2], d[i + 3]);
    };
  }
  rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }
  spawn(pan, gain, size, delay) {
    const v = this.next; this.next = (this.next + 1) % this.V;
    if (this.live[v]) this.stats.steal++;
    this.stats.n++;
    const big = Math.min(1, size / 0.06);
    // grains are sorted bright -> deep; bigger drops pick from deeper recordings, with jitter
    const pick = Math.min(this.nG - 1, Math.max(0, Math.floor((0.15 + 0.7 * big + (this.rnd() - 0.5) * 0.5) * this.nG)));
    this.g[v] = pick; this.pos[v] = 0;
    this.rate[v] = (1.35 - 0.6 * big) * (0.85 + 0.3 * this.rnd()) * (44100 / sampleRate);
    const p = Math.max(-1, Math.min(1, pan)) * 0.5 + 0.5, a = gain * 0.14 * (0.6 + 0.4 * this.rnd());   // real drops are dense: many overlap
    this.gl[v] = Math.cos(p * 1.5708) * a; this.gr[v] = Math.sin(p * 1.5708) * a;
    this.wait[v] = Math.floor(delay * sampleRate); this.live[v] = 1;
  }
  process(ins, outs) {
    const o = outs[0], L = o[0], Rr = o[1] || o[0], n = L.length, V = this.V, B = this.bank;
    for (let k = 0; k < n; k++) { L[k] = 0; if (Rr !== L) Rr[k] = 0; }
    if (!B) return true;
    for (let v = 0; v < V; v++) {
      if (!this.live[v]) continue;
      let k = 0;
      if (this.wait[v] > 0) { k = Math.min(n, this.wait[v]); this.wait[v] -= k; if (k >= n) continue; }
      const s0 = this.st[this.g[v]], r = this.rate[v], ln = Math.min(this.len[this.g[v]] - 1, 0.14 * sampleRate * r), gl = this.gl[v], gr = this.gr[v];   // <= 0.14 s per drop
      let p = this.pos[v];
      for (; k < n; k++) {
        if (p >= ln) { this.live[v] = 0; break; }
        const i = p | 0, f = p - i, x = (B[s0 + i] + (B[s0 + i + 1] - B[s0 + i]) * f) * Math.min(1, (ln - p) / (300 * r));   // short fade at the cut
        L[k] += x * gl; Rr[k] += x * gr; p += r;
      }
      this.pos[v] = p;
    }
    if ((currentFrame & 32767) < n) { this.port.postMessage(this.stats); this.stats = { n: 0, steal: 0 }; }
    return true;
  }
}
registerProcessor('drops', Drops);
`;

export class Audio {
  constructor() {
    this.ctx = null; this.buf = {}; this.loops = {}; this.muted = false;
    let saved = {}; try { saved = JSON.parse(localStorage.getItem('deepsea.breath') || '{}'); } catch (e) { /* storage unavailable */ }
    this.breathOn = saved.on ?? true; this.breathVol = saved.vol ?? 0.6;
    this.breathNext = 0; this.breathHist = []; this.exhaleUntil = 0;
  }
  saveBreath() { try { localStorage.setItem('deepsea.breath', JSON.stringify({ on: this.breathOn, vol: this.breathVol })); } catch (e) { /* ignore */ } }
  // cut a breathing recording into single breath phases at its loudness dips
  segment(name) {
    const b = this.buf[name]; if (!b) return [];
    const x = b.getChannelData(0), sr = b.sampleRate, hop = Math.round(sr * 0.02), env = [];
    for (let i = 0; i + hop <= x.length; i += hop) { let e = 0; for (let k = 0; k < hop; k++) e += x[i + k] * x[i + k]; env.push(Math.sqrt(e / hop)); }
    const sm = env.map((_, i) => { let a = 0, n = 0; for (let k = -5; k <= 5; k++) if (env[i + k] !== undefined) { a += env[i + k]; n++; } return a / n; });
    const med = [...sm].sort((a, b) => a - b)[sm.length >> 1];
    const cuts = [0];
    for (let i = 5; i < sm.length - 5; i++) {
      const t = i * 0.02;
      if (sm[i] < med * 0.8 && sm[i] <= sm[i - 1] && sm[i] <= sm[i + 1] && t - cuts[cuts.length - 1] > 0.9) cuts.push(t);
    }
    cuts.push(x.length / sr);
    const segs = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const s = cuts[i], e = cuts[i + 1]; if (e - s < 0.6 || e - s > 4.5) continue;
      let m = 0; const a = Math.floor(s / 0.02), z = Math.floor(e / 0.02); for (let k = a; k < z; k++) m += sm[k]; m /= Math.max(1, z - a);
      segs.push({ name, s, e, loud: m > med * 1.05 });
    }
    return segs;
  }
  // irregular breathing: random breath phases, varied rate/gain/gaps; faster with exertion (0..1). Returns true while exhaling.
  // startle: cut the current breath and take a sharp inhale right now
  gasp() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.breathSrc) { try { this.breathSrc.g.gain.cancelScheduledValues(now); this.breathSrc.g.gain.setTargetAtTime(0, now, 0.03); } catch (e) {} }
    this.phaseExhale = true; this.breathNext = now; this.gaspNext = true; this.exhaleUntil = 0;
  }
  breathe(exertion, active) {
    if (!this.ctx || !this.segs?.length) return false;
    const now = this.ctx.currentTime;
    if (active && now >= this.breathNext) {
      // alternate inhale (quieter phases) and exhale (louder, bubbling phases)
      this.phaseExhale = !this.phaseExhale;
      const pool = this.segs.filter((q) => q.loud === this.phaseExhale);
      const from = pool.length ? pool : this.segs;
      let seg, tries = 0;
      do { seg = from[(Math.random() * from.length) | 0]; } while (this.breathHist.includes(seg) && ++tries < 8);
      this.breathHist.push(seg); if (this.breathHist.length > 3) this.breathHist.shift();
      let rate = 0.9 + Math.random() * 0.16 + exertion * 0.22;
      const gasping = this.gaspNext; this.gaspNext = false;
      if (gasping) rate = 1.3 + Math.random() * 0.1;
      const dur = (seg.e - seg.s) / rate;
      const vol = this.breathOn ? this.breathVol * (0.7 + Math.random() * 0.4) * (0.85 + exertion * 0.45) * (gasping ? 1.5 : 1) : 0;
      const src = this.ctx.createBufferSource(); src.buffer = this.buf[seg.name]; src.playbackRate.value = rate;
      const g = this.ctx.createGain(); g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(vol, now + 0.08);
      g.gain.setValueAtTime(vol, now + dur - 0.12); g.gain.linearRampToValueAtTime(0, now + dur);
      src.connect(g); g.connect(this.helmet); src.start(now, seg.s, seg.e - seg.s); src.stop(now + dur + 0.05);
      this.breathSrc = { src, g };
      if (seg.loud) this.exhaleUntil = now + dur;
      // pause before the next phase: short when working hard, sometimes a long calm hold
      let gap = this.phaseExhale ? (0.08 + (1 - exertion) * 1.2) * (0.4 + Math.random() * 1.2) : 0.03 + Math.random() * 0.25 * (1 - exertion);   // panting when exerted/frightened
      if (this.phaseExhale && Math.random() < 0.12 * (1 - exertion)) gap += 1.5 + Math.random() * 2.5;
      this.breathNext = now + dur + gap;
    }
    return now < this.exhaleUntil;
  }
  setBreath(on, vol) {
    if (on !== undefined) this.breathOn = on;
    if (vol !== undefined) this.breathVol = Math.max(0, Math.min(1, vol));
    if (this.breathSrc && this.ctx) this.breathSrc.g.gain.cancelScheduledValues(this.ctx.currentTime), this.breathSrc.g.gain.setTargetAtTime(this.breathOn ? this.breathVol * 0.9 : 0, this.ctx.currentTime, 0.05);
    this.saveBreath();
  }
  async init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx;
    const phone = matchMedia('(pointer: coarse)').matches;
    try { ctx = new AC(phone ? { latencyHint: 'playback' } : {}); } catch (e) { ctx = new AC(); }   // phones: bigger buffers, fewer device start failures
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 20000; this.lp.Q.value = 0.4;
    this.amb = ctx.createGain(); this.sfx = ctx.createGain();
    this.amb.connect(this.lp); this.sfx.connect(this.lp); this.lp.connect(this.master); this.master.connect(ctx.destination);
    // breathing bypasses the water filter (inside the helmet)
    this.helmet = ctx.createGain(); this.helmet.connect(this.master);
    await Promise.all(FILES.map(async (n) => {
      try {
        const ab = await (await fetch(`assets/audio/game/${n}.ogg`)).arrayBuffer();
        this.buf[n] = await ctx.decodeAudioData(ab);
      } catch (e) { console.warn('audio', n, e); }
    }));
    // distant bus: muffled + long synthetic reverb tail (sound travelling kilometres through water)
    this.far = ctx.createBiquadFilter(); this.far.type = 'lowpass'; this.far.frequency.value = 520; this.far.Q.value = 0.3;
    const rev = ctx.createConvolver(), len = ctx.sampleRate * 5, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    rev.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.55; const dry = ctx.createGain(); dry.gain.value = 0.35;
    this.far.connect(rev); rev.connect(wet); wet.connect(this.master); this.far.connect(dry); dry.connect(this.master);
    // depth announcement voice (helmet radio)
    try {
      this.voiceLines = await (await fetch('assets/audio/voice/lines.json')).json();
      await Promise.all(this.voiceLines.map(async ([, n]) => {
        try { this.buf[n] = await ctx.decodeAudioData(await (await fetch(`assets/audio/voice/${n}.ogg`)).arrayBuffer()); } catch (e) { console.warn('voice', n, e); }
      }));
    } catch (e) { this.voiceLines = []; }
    // drop-rain synthesiser (audio thread)
    try {
      const url = URL.createObjectURL(new Blob([DROPS_WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      this.dropNode = new AudioWorkletNode(ctx, 'drops', { numberOfInputs: 0, outputChannelCount: [2] });
      const g = ctx.createGain(); g.gain.value = 0.55; this.dropNode.connect(g); g.connect(this.sfx);
      this.dropStats = { n: 0, steal: 0 }; this.dropNode.port.onmessage = (e) => { this.dropStats = e.data; };
      this.dropBuf = new Float32Array(200 * 4);   // ~8k grains/s: past this density more drops are not heard as more
      // the sample bank: real drops-into-water, cut into single drops offline (assets/audio/game/drop_grains.*)
      try {
        const [ab, idx] = await Promise.all([fetch('assets/audio/game/drop_grains.ogg').then((r) => r.arrayBuffer()), fetch('assets/audio/game/drop_grains.json').then((r) => r.json())]);
        const buf = await ctx.decodeAudioData(ab), sr = buf.sampleRate, ch = buf.getChannelData(0);
        const st = new Int32Array(idx.map((q) => Math.round(q[0] * sr))), len = new Int32Array(idx.map((q) => Math.round(q[1] * sr)));
        this.dropNode.port.postMessage({ bank: ch.slice(), st, len });
      } catch (e) { console.warn('drop grains', e); }
    } catch (e) { console.warn('drops worklet', e); }
    this.segs = [...this.segment('breath_mask'), ...this.segment('breath_scuba')];
    console.log('breath segments', this.segs.length);
    // phones: the audio device can refuse to start (another app holds it, screen locked, call, backgrounded) —
    // resume() then rejects with "Failed to start the audio device". Never let that escape; retry on the next touch/key.
    document.addEventListener('visibilitychange', () => { if (document.hidden) ctx.suspend().catch(() => {}); else this.wake(); });
    ctx.addEventListener?.('statechange', () => { if (ctx.state !== 'running' && !document.hidden) this.wake(); });
    for (const ev of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(ev, () => this.wake(), { capture: true, passive: true });
    this.wake();
  }
  wake() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed' || document.hidden || this.waking) return;
    this.waking = true;
    ctx.resume().catch((e) => console.warn('audio resume', e?.message || e)).finally(() => { this.waking = false; });
  }
  // ---- 3D sound: HRTF panner at a world position (distance loudness stays with the caller's vol: rolloff 0) ----
  setListener(pos, fwd, up) {
    const L = this.ctx?.listener; if (!L) return;
    const t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(pos[0], t, 0.02); L.positionY.setTargetAtTime(pos[1], t, 0.02); L.positionZ.setTargetAtTime(pos[2], t, 0.02);
      L.forwardX.setTargetAtTime(fwd[0], t, 0.02); L.forwardY.setTargetAtTime(fwd[1], t, 0.02); L.forwardZ.setTargetAtTime(fwd[2], t, 0.02);
      L.upX.setTargetAtTime(up[0], t, 0.02); L.upY.setTargetAtTime(up[1], t, 0.02); L.upZ.setTargetAtTime(up[2], t, 0.02);
    } else { L.setPosition(...pos); L.setOrientation(...fwd, ...up); }
    this.lpos = pos; this.lfwd = fwd;
  }
  panner(pos) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 1; p.rolloffFactor = 0; p.maxDistance = 10000;
    this.place(p, pos);
    return p;
  }
  place(p, pos) {
    if (!pos) return;
    const t = this.ctx.currentTime;
    if (p.positionX) { p.positionX.setTargetAtTime(pos[0], t, 0.03); p.positionY.setTargetAtTime(pos[1], t, 0.03); p.positionZ.setTargetAtTime(pos[2], t, 0.03); }
    else p.setPosition(...pos);
  }
  // route a node: world position -> HRTF, else stereo pan, else straight
  route(node, opts, dest) {
    if (opts.pos && this.lpos) { const p = this.panner(opts.pos); node.connect(p); p.connect(dest); return; }
    if (opts.pan !== undefined) { const p = this.ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, opts.pan)); node.connect(p); p.connect(dest); return; }
    node.connect(dest);
  }
  // hand this frame's landing drops to the synthesiser: one small copy, no per-drop nodes
  drops(buf, count) {
    if (!this.dropNode || !count) return;
    this.dropNode.port.postMessage(buf.slice(0, count * 4));
  }
  loop(name, bus = 'amb', vol = 0) {
    if (!this.buf[name]) return null;
    const s = this.ctx.createBufferSource(); s.buffer = this.buf[name]; s.loop = true;
    const g = this.ctx.createGain(); g.gain.value = vol;
    s.connect(g); g.connect(bus === 'helmet' ? this.helmet : bus === 'sfx' ? this.sfx : this.amb);
    s.start(0, Math.random() * this.buf[name].duration);
    return (this.loops[name] = { s, g });
  }
  setLoop(name, vol, tc = 0.8) {
    const l = this.loops[name]; if (!l) return;
    l.g.gain.setTargetAtTime(vol, this.ctx.currentTime, tc);
  }
  // pos relative to listener in view space (x right, z forward) for simple panning
  play(name, vol = 1, opts = {}) {
    if (!this.ctx || !this.buf[name]) return;
    const s = this.ctx.createBufferSource(); s.buffer = this.buf[name];
    s.playbackRate.value = opts.rate || 1;
    const g = this.ctx.createGain(); g.gain.value = vol;
    s.connect(g); this.route(g, opts, opts.bus === 'helmet' ? this.helmet : this.sfx);
    s.start();
    return { s, g };
  }
  // short enveloped slice of a longer recording (e.g. a wave wash from the surf loop), random offset
  slice(name, vol = 1, opts = {}) {
    if (!this.ctx || !this.buf[name]) return;
    const b = this.buf[name], dur = Math.min(opts.dur || 1.2, b.duration - 0.1), now = this.ctx.currentTime;
    const off = opts.offset ?? Math.random() * Math.max(0, b.duration - dur - 0.1);
    const s = this.ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = opts.rate || 1;
    const g = this.ctx.createGain(); const att = opts.att ?? 0.04;
    g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(vol, now + att); g.gain.setValueAtTime(vol, now + dur * 0.35); g.gain.exponentialRampToValueAtTime(0.0005, now + dur);
    s.connect(g); this.route(g, opts, this.sfx); s.start(now, off, dur + 0.05);
  }
  // continuous positional layer (e.g. a colossal animal's presence); control gain/pan/rate per frame
  presence(name, rate = 1) {
    if (!this.ctx || !this.buf[name]) return null;
    const s = this.ctx.createBufferSource(); s.buffer = this.buf[name]; s.loop = true; s.playbackRate.value = rate;
    const g = this.ctx.createGain(); g.gain.value = 0; const p = this.ctx.createStereoPanner(); const hp = this.panner(null);
    s.connect(g); g.connect(p); p.connect(hp); hp.connect(this.sfx); s.start();
    return { s, g, p, set: (vol, pan, r, pos) => { const t = this.ctx.currentTime; g.gain.setTargetAtTime(vol, t, 0.4);
      if (pos && this.lpos) { p.pan.setTargetAtTime(0, t, 0.2); this.place(hp, pos); }
      else { p.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.4); if (this.lpos) this.place(hp, this.front()); } if (r) s.playbackRate.setTargetAtTime(r, t, 0.5); } };
  }
  front() { return this.lfwd && this.lpos ? [this.lpos[0] + this.lfwd[0], this.lpos[1] + this.lfwd[1], this.lpos[2] + this.lfwd[2]] : null; }
  // procedural water-rush / churning turbulence (brown noise through a wandering low-pass); set(vol, pan, bright 0..1)
  turbulence() {
    if (!this.ctx) return null;
    const ctx = this.ctx, n = ctx.sampleRate * 4, b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let last = 0; for (let i = 0; i < n; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; } }
    const s = ctx.createBufferSource(); s.buffer = b; s.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180; lp.Q.value = 0.9;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.37; const lg = ctx.createGain(); lg.gain.value = 60; lfo.connect(lg); lg.connect(lp.frequency); lfo.start();
    const g = ctx.createGain(); g.gain.value = 0; const p = ctx.createStereoPanner();
    s.connect(lp); lp.connect(g); g.connect(p); p.connect(this.sfx); s.start();
    return { set: (vol, pan, bright = 0.3) => { const t = ctx.currentTime; g.gain.setTargetAtTime(vol, t, 0.25); p.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.3); lp.frequency.setTargetAtTime(120 + 700 * bright, t, 0.3); lfo.frequency.setTargetAtTime(0.3 + bright * 1.2, t, 0.5); } };
  }
  // streamed music cues (HTMLAudioElement → WebAudio) with crossfades; missing files are skipped quietly
  music(name, fade = 3) {
    if (!this.ctx || this.curMusic === name) return;
    this.curMusic = name;
    const now = this.ctx.currentTime;
    if (!this.musicBus) { this.musicBus = this.ctx.createGain(); this.musicBus.gain.value = 0.55; this.musicBus.connect(this.master); this.tracks = {}; }
    for (const [n, tr] of Object.entries(this.tracks)) if (n !== name) {
      tr.g.gain.cancelScheduledValues(now); tr.g.gain.setTargetAtTime(0, now, fade / 3);
      clearTimeout(tr.stopT); tr.stopT = setTimeout(() => { if (this.curMusic !== n) tr.el.pause(); }, fade * 1500 + 500);
    }
    if (!name) return;
    let tr = this.tracks[name];
    if (!tr) {
      const el = new window.Audio(`assets/music/${name}.mp3`); el.loop = true; el.preload = 'auto';
      el.onerror = () => { tr.bad = true; };
      const src = this.ctx.createMediaElementSource(el), g = this.ctx.createGain(); g.gain.value = 0;
      src.connect(g); g.connect(this.musicBus);
      tr = this.tracks[name] = { el, g };
    }
    if (tr.bad) return;
    clearTimeout(tr.stopT);
    if (tr.el.paused) { tr.el.currentTime = 0; tr.el.play().catch(() => {}); }
    tr.g.gain.cancelScheduledValues(now); tr.g.gain.setTargetAtTime(1, now, fade / 3);
  }
  setMusicLevel(v) { if (this.musicBus) this.musicBus.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.8); }
  // soft two-note glass chime (rising = on, falling = off), synthesised
  chime(up = true) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime, notes = up ? [523.25, 783.99] : [783.99, 523.25];
    const out = this.ctx.createGain(); out.gain.value = 0.9;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.3;
    out.connect(lp); lp.connect(this.helmet);
    notes.forEach((f, i) => {
      const t0 = now + i * 0.13;
      for (const [mul, type, vol] of [[1, 'sine', 0.07], [2, 'sine', 0.018], [0.5, 'triangle', 0.02]]) {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type; o.frequency.value = f * mul; o.detune.value = (Math.random() - 0.5) * 6;
        g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.025); g.gain.exponentialRampToValueAtTime(1e-4, t0 + 1.1);
        o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + 1.2);
      }
    });
  }
  // helmet voice announcement; ducks the ambience while speaking
  voice(name) {
    if (!this.ctx || !this.buf[name]) return;
    const now = this.ctx.currentTime, dur = this.buf[name].duration;
    this.play('hud_beep', 0.3, { bus: 'helmet' });
    const s = this.ctx.createBufferSource(); s.buffer = this.buf[name];
    const g = this.ctx.createGain(); g.gain.value = 1.0;
    s.connect(g); g.connect(this.helmet); s.start(now + 0.25);
    this.amb.gain.cancelScheduledValues(now); this.amb.gain.setTargetAtTime(0.35, now, 0.15);
    this.amb.gain.setTargetAtTime(1.0, now + 0.25 + dur, 0.6);
  }
  // a whale calling somewhere far away
  whale() {
    if (!this.ctx) return;
    const name = Math.random() < 0.6 ? 'whale_low' : 'whale_creepy';
    const b = this.buf[name]; if (!b) return;
    const s = this.ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = 0.7 + Math.random() * 0.35;
    const g = this.ctx.createGain(); const now = this.ctx.currentTime, v = 0.35 + Math.random() * 0.4;
    g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(v, now + 1.5);
    const p = this.ctx.createStereoPanner(); p.pan.value = Math.random() * 1.6 - 0.8;
    s.connect(g); g.connect(p); p.connect(this.far); s.start();
  }
  // ---- procedural deep-sea biophony ----
  // kind: 'drum'  fish sonic-muscle drumming (grenadiers, cusk-eels): train of damped low pulses
  //       'grunt' single croak;  'click' sperm-whale echolocation click train (distant);  'creak' click buzz
  //       'swish' water rushing past (close pass of an animal);  'shimmer' faint glassy tinkle (siphonophore / comb jelly)
  bio(kind, vol = 0.5, pan = 0, far = false, pos = null) {
    if (!this.ctx || vol < 0.005) return;
    const ctx = this.ctx, now = ctx.currentTime + 0.02;
    const out = ctx.createGain(); out.gain.value = vol;
    this.route(out, pos ? { pos } : { pan }, far ? this.far : this.sfx);
    const pulse = (t0, f, dec, amp) => {
      const o = ctx.createOscillator(); o.frequency.value = f; o.type = 'sine';
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(amp, t0 + 0.004); g.gain.exponentialRampToValueAtTime(0.0005, t0 + dec);
      o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + dec + 0.02);
    };
    const noise = (t0, dur, f0, f1, q, amp, att = 0.01) => {
      const n = Math.ceil(ctx.sampleRate * dur), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = b;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q; bp.frequency.setValueAtTime(f0, t0); bp.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(amp, t0 + att); g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
      src.connect(bp); bp.connect(g); g.connect(out); src.start(t0);
    };
    if (kind === 'drum') {
      const n = 6 + (Math.random() * 14) | 0, rate = 18 + Math.random() * 22, f = 90 + Math.random() * 110;
      for (let i = 0; i < n; i++) pulse(now + i / rate, f * (1 + 0.04 * Math.sin(i)), 0.06, 0.9 * (1 - 0.3 * i / n));
    } else if (kind === 'grunt') {
      const f = 70 + Math.random() * 60, n = 3 + (Math.random() * 4) | 0;
      for (let i = 0; i < n; i++) pulse(now + i * 0.018, f, 0.12, 0.7);
      noise(now, 0.25, 300, 160, 1.5, 0.25);
    } else if (kind === 'click') {
      const n = 8 + (Math.random() * 16) | 0, ici = 0.45 + Math.random() * 0.5;
      for (let i = 0; i < n; i++) noise(now + i * ici * (0.9 + Math.random() * 0.2), 0.03, 4000, 1800, 0.8, 0.9, 0.001);
    } else if (kind === 'creak') {
      const n = 40 + (Math.random() * 60) | 0; let t = now, ici = 0.12;
      for (let i = 0; i < n; i++) { noise(t, 0.02, 3500, 2000, 0.8, 0.6, 0.001); ici *= 0.965; t += Math.max(0.012, ici); }
    } else if (kind === 'swish') {
      noise(now, 0.9 + Math.random() * 0.5, 180, 900 + Math.random() * 600, 0.7, 0.9, 0.25);
    } else if (kind === 'bigblow') {     // humpback exhalation: a long, deep, roaring 'whooosh' and a breathy tail
      noise(now, 1.6, 900, 250, 0.5, 1.0, 0.05); noise(now + 0.05, 1.3, 220, 90, 0.8, 0.8, 0.08); noise(now + 1.0, 1.0, 1400, 500, 0.5, 0.25, 0.2);
    } else if (kind === 'blow') {        // dolphin exhalation: sharp breathy 'pfff' through the blowhole
      noise(now, 0.35, 2500, 900, 0.6, 1.0, 0.015); noise(now + 0.02, 0.25, 600, 300, 1.0, 0.4, 0.01);
    } else if (kind === 'slap') {        // humpback lobtail: a gunshot-like 'CRACK' of the fluke hitting flat water, a deep
                                         // body thump, the tearing roar of the crown sheet, then the rain of water falling back
      noise(now, 0.09, 3200, 1100, 0.35, 1.4, 0.0008);                    // the crack
      noise(now + 0.004, 0.22, 1400, 400, 0.5, 0.9, 0.002);
      pulse(now, 62, 0.55, 1.0); pulse(now + 0.01, 41, 0.9, 0.9);        // thump through the water
      noise(now + 0.03, 1.1, 700, 180, 0.6, 0.7, 0.03);                   // the sheet tearing up
      noise(now + 0.6, 2.2, 2400, 900, 0.4, 0.35, 0.35);                  // rain of falling water
      for (let i = 0; i < 70; i++) { const t0 = now + 0.7 + Math.random() * 2.0; noise(t0, 0.03, 2000 + Math.random() * 3000, 1200, 0.9, 0.12 + Math.random() * 0.15, 0.001); }
    } else if (kind === 'shimmer') {
      for (let i = 0; i < 5; i++) { const t0 = now + i * (0.12 + Math.random() * 0.2); pulse(t0, 1800 + Math.random() * 2400, 0.5, 0.12); }
    }
  }
  setUnderwater(u) {
    if (!this.ctx) return;
    this.lp.frequency.setTargetAtTime(u ? 900 : 20000, this.ctx.currentTime, 0.15);
  }
  toggleMute() {
    this.muted = !this.muted;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }
}
