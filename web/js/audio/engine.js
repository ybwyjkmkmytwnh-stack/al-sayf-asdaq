// المحرّك الحي: ميكروفون + مرجع → إطارات منسوبة زمنيًا، مع ساعة/كمون/معايرة/كشف تسرّب/أحداث الأجهزة.
//
// مسار الصوت (لا يصل الميكروفون إلى المكبّر أبدًا):
//   <audio> ──► MediaElementSource ──┬──► listenGain ──► destination        (مستوى الاستماع فقط؛ لا يؤثر على التقييم)
//                                    └──► CaptureProcessor[مدخل 1]  «التقاط المرجع قبل مقياس الصوت»
//   getUserMedia ─► MediaStreamSource ───► CaptureProcessor[مدخل 0]
//   CaptureProcessor ─► gain(0) ─► destination   (خرج صامت لإبقاء العقدة تُسحب فقط)
// العلاقة الزمنية الكاملة موثّقة في core/sync.js (اصطلاح الإشارة والمعادلة 1).
import { Session, suggestComfortOffset } from '../core/session.js';
import { LatencyModel } from '../core/sync.js';
import { scoreWindow, computeConfidence } from '../core/score.js';
import { computeLive, HintController } from '../core/live.js';
import { median, percentile } from '../core/dsp.js';
import { describeMediaError, DEVICE_MESSAGES } from './errors.js';

export const ENGINE_PARAMS = Object.freeze({ hopSec: 0.01, windowSec: 0.04, fmin: 65, fmax: 800, chunk: 2048 });
export const TAIL_SEC = 0.35;           // ذيل بعد نهاية النافذة قبل الإيقاف (لتصل آخر الإطارات)
// أسباب التشغيل التي «تكمل» المحاولة الحالية (لا تبدأ محاولة جديدة): تبقى بيانات ما قبلها ضمن نفس المحاولة.
const CONTINUATION = new Set(['seek', 'resume', 'media-resume', 'discontinuity']);
export const LEAK_VIOLATION_REL_DB = -30; // تسرّب أعلى من (صوت المستخدم −30 dB) أثناء صمته = مخالفة استقلال
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function supportInfo(win = globalThis) {
  const nav = win.navigator || {};
  return {
    secureContext: !!win.isSecureContext,
    audioContext: !!(win.AudioContext || win.webkitAudioContext),
    audioWorklet: !!(win.AudioContext && win.AudioContext.prototype && 'audioWorklet' in win.AudioContext.prototype),
    getUserMedia: !!(nav.mediaDevices && nav.mediaDevices.getUserMedia),
    worker: typeof win.Worker === 'function',
    // الصفحة مضمَّنة في إطار لا يسمح بالميكروفون (مثل صفحات المعاينة): لا يفيد فيه أي «سماح» من المستخدم
    micPolicyBlocked: (() => {
      try {
        const pp = win.document && (win.document.permissionsPolicy || win.document.featurePolicy);
        return !!(pp && typeof pp.allowsFeature === 'function' && pp.allowsFeature('microphone') === false);
      } catch { return false; }
    })(),
  };
}

export class Engine extends EventTarget {
  constructor({ ref, audioUrl }) {
    super();
    this.ref = ref;
    this.audioUrl = audioUrl;
    this.session = new Session();
    this.latency = new LatencyModel();
    this.hints = new HintController();
    this.settings = { headphones: true, mode: 'strict', listenVolume: 0.8, manualSec: 0 };
    this.calibration = { done: false, noiseFloorDb: null, noiseP95Db: null, comfortLevelDb: null, userMedianCents: null, rangeCents: null, offsetCents: 0, suggestedOffsetCents: 0, voicedSec: 0, at: null };
    this.leak = { probed: false, valid: null, level: null, lagMs: null, micProbeDb: null, relVoiceDb: null, detected: false, weak: false, monitorHits: 0, monitorLevel: null, at: null };
    this.trackInfo = null;
    this.sync = { delta: null, corr: null, count: 0, driftPpm: 0, lastOk: false, lastReason: null };
    this.epoch = 0;
    this.state = 'new';           // new → ready → playing/paused (+ micOn منفصل)
    this.micOn = false;
    this.micMuted = false;
    this.digitalSilence = false;
    this.collector = null;
    this.seg = null;
    this.runFirstSegId = null;    // أول مقطع في «المحاولة» الحالية: التقييم الافتراضي لا يقرأ مقاطع محاولات أقدم
    this.playRange = null;
    this.latest = null;           // آخر إطار ميكروفون (للعدّاد)
    this.liveState = null;
    this.events = [];             // سجل أحداث الأجهزة/الجلسة (يُعرض في المراجعة ويُستعمل في الاختبار)
    this._timers = {};
    this._leakResults = [];
  }

  // ───────────────────────── الإقلاع ─────────────────────────
  async init() {
    if (this.ctx) return this;
    const sup = supportInfo();
    if (!sup.audioContext || !sup.audioWorklet || !sup.worker) {
      const why = !sup.secureContext ? 'الصفحة ليست آمنة (استعمل localhost أو HTTPS)' : 'المتصفح لا يدعم AudioWorklet/Worker';
      throw Object.assign(new Error(`تعذّر تشغيل محرّك الصوت: ${why}.`), { code: 'unsupported', support: sup });
    }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.ctx.onstatechange = () => this._onCtxState();
    await this.ctx.resume();
    await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url).href);
    this.worker = new Worker(new URL('./pitch-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onWorker(e.data);
    this.worker.onerror = (e) => this._event('worker-error', { message: String(e.message || e) });
    const ready = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('انتهت مهلة تشغيل عامل التحليل')), 10000);
      this._workerReady = (m) => { clearTimeout(t); resolve(m); };
      this.worker.postMessage({ type: 'init', params: { hopSec: ENGINE_PARAMS.hopSec, windowSec: ENGINE_PARAMS.windowSec, fmin: ENGINE_PARAMS.fmin, fmax: ENGINE_PARAMS.fmax }, ctxRate: this.ctx.sampleRate, epoch: this.epoch });
    });
    this.analyzerInfo = { ctxRate: this.ctx.sampleRate, effectiveRate: ready.effectiveRate, decimation: ready.decimation, geometry: ready.geometry };

    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.src = this.audioUrl;
    this.audio.playbackRate = 1;            // السرعة والطبقة الأصليتان
    this.audio.addEventListener('waiting', () => this._onMediaStall());
    this.audio.addEventListener('stalled', () => this._onMediaStall());
    this.audio.addEventListener('ended', () => { if (this.state === 'playing') this._finish('media-ended'); });
    this.audio.addEventListener('error', () => this._event('media-error', { code: this.audio.error?.code }));
    this.src = this.ctx.createMediaElementSource(this.audio);
    this.listenGain = this.ctx.createGain();
    this.listenGain.gain.value = this.settings.listenVolume;
    this.src.connect(this.listenGain).connect(this.ctx.destination);
    this.capture = new AudioWorkletNode(this.ctx, 'capture-processor', {
      numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { chunk: ENGINE_PARAMS.chunk },
    });
    this.src.connect(this.capture, 0, 1);       // نسخة المرجع قبل listenGain
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.capture.connect(this.sink).connect(this.ctx.destination);
    this.capture.port.onmessage = (e) => {
      if (e.data?.type !== 'chunk') return;
      const m = e.data;
      this._onRawChunk(m);
      this.worker.postMessage({ type: 'chunk', frame0: m.frame0, n: m.n, mic: m.mic, tap: m.tap, micPresent: m.micPresent, micMaxAbs: m.micMaxAbs }, [m.mic, m.tap]);
    };
    document.addEventListener('visibilitychange', this._onVisibility = () => { if (document.hidden && this.state === 'playing') { this._finish('tab-hidden'); this._event('tab-hidden', { message: 'أُوقف التدريب لأن الصفحة خرجت من الواجهة.' }); } });
    this._refreshLatency();
    this.state = 'ready';
    this._emit('state', this.status());
    return this;
  }

  /** مسار عرض مباشر لا يعتمد على مزامنة δ: كل إطار يُنسب لموضع المرجع المسموع وقت التقاطه تقريبيًا. للعرض فقط؛ التقييم لا يستعمله. */
  _pushTrail(f) {
    const tr = this.trail || (this.trail = []);
    let tRef = null;
    if (this.state === 'playing' && this.audio) tRef = this.audio.currentTime - (this.ctx.currentTime - f.tCtx);
    tr.push({ tRef, wall: performance.now(), tCtx: f.tCtx, c: Number.isFinite(f.f0) && f.f0 > 0 ? 1200 * Math.log2(f.f0 / 100) : NaN, db: f.energyDb, voiced: !!f.voiced && !f.unmeasurable, per: f.periodicity });
    if (tr.length > 700) tr.splice(0, tr.length - 600);
  }

  // مستوى الإدخال الفوري + تسجيل مقطع قصير محلي (لا يمرّ بكاشف النغمة): يفصل «وصول العيّنات» عن «نجاح قياس النبرة».
  _onRawChunk(m) {
    const n = m.n || 0; if (!n) return;
    const x = new Float32Array(m.mic, 0, n);
    let ss = 0, pk = 0;
    for (let i = 0; i < n; i++) { const v = x[i]; ss += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
    const rms = Math.sqrt(ss / n);
    this.input = { rms, peak: pk, db: 20 * Math.log10(rms + 1e-9), at: performance.now(), present: !!m.micPresent, chunks: (this.input?.chunks || 0) + 1, samples: (this.input?.samples || 0) + n };
    if (this._clip) { this._clip.parts.push(x.slice()); this._clip.n += n; this._clip.peak = Math.max(this._clip.peak, pk); if (this._clip.n >= this._clip.need) { const c = this._clip; this._clip = null; c.resolve(c); } }
    this._emit('level', this.input);
  }

  /** يسجّل ثوانيَ من الميكروفون محليًّا فقط (بلا إرسال لأي جهة) ويعيد العيّنات الخام. */
  recordClip(sec = 3) {
    if (!this.micOn) return Promise.reject(new Error('الميكروفون غير مفعّل.'));
    if (this._clip) return Promise.reject(new Error('التسجيل جارٍ.'));
    const rate = this.ctx.sampleRate;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { const c = this._clip; this._clip = null; if (c && c.n === 0) reject(new Error('لم تصل أي عيّنات صوت من الميكروفون خلال المهلة.')); else if (c) resolve(c); }, sec * 1000 + 2500);
      this._clip = { parts: [], n: 0, need: Math.round(sec * rate), peak: 0, resolve: (c) => { clearTimeout(t); resolve(c); } };
    }).then((c) => {
      const out = new Float32Array(c.n); let o = 0; for (const p of c.parts) { out.set(p, o); o += p.length; }
      let ss = 0; for (let i = 0; i < out.length; i++) ss += out[i] * out[i];
      return { samples: out, rate, peak: c.peak, rms: Math.sqrt(ss / Math.max(1, out.length)), sec: out.length / rate };
    });
  }

  /** يشغّل عيّنات خام عبر المخرج (للاستماع إلى ما سُجّل). */
  playSamples(samples, rate) {
    const buf = this.ctx.createBuffer(1, samples.length, rate); buf.getChannelData(0).set(samples);
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.ctx.destination); src.start();
    return new Promise((r) => { src.onended = r; });
  }

  _refreshLatency() {
    const s = this.trackInfo?.settings || {};
    this.latency = new LatencyModel({
      baseLatency: this.ctx?.baseLatency || 0, outputLatency: this.ctx?.outputLatency || 0,
      inputLatency: typeof s.latency === 'number' ? s.latency : 0, manualSec: this.settings.manualSec,
    });
  }

  // ───────────────────────── الميكروفون ─────────────────────────
  async enableMic({ headphones = this.settings.headphones, deviceId = null } = {}) {
    if (!this.ctx) await this.init();
    this.settings.headphones = headphones;
    this._releaseMic();
    // سماعات: بلا أي معالجة (طبقة أنقى). مكبّرات: إلغاء صدى فقط (يخفّف تسرّب المرجع) ويُسجَّل أنه معالجة.
    const base = { channelCount: { ideal: 1 }, echoCancellation: !headphones, noiseSuppression: false, autoGainControl: false };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false });
    } catch (err) {
      const d = describeMediaError(err);
      if (d.code === 'constraints') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false });
      } else { this._event('mic-error', d); throw Object.assign(new Error(d.message), { code: d.code, fatal: d.fatal, cause: err }); }
    }
    const track = stream.getAudioTracks()[0];
    let s = track.getSettings?.() || {};
    // تحقق فعلي من الإعدادات المطبّقة؛ إن لم تُحترم نحاول مرة واحدة ثم نسجّل الحقيقة
    const wants = { echoCancellation: base.echoCancellation, noiseSuppression: false, autoGainControl: false };
    const honored = (x) => x.echoCancellation === wants.echoCancellation && x.noiseSuppression !== true && x.autoGainControl !== true;
    if (!honored(s) && track.applyConstraints) { try { await track.applyConstraints(wants); s = track.getSettings(); } catch { /* نسجّل الواقع */ } }
    const flag = (v) => (v === undefined ? null : v);
    const processing = { agc: flag(s.autoGainControl), ns: flag(s.noiseSuppression), ec: flag(s.echoCancellation) };
    this.trackInfo = {
      label: track.label, deviceId: s.deviceId || null, settings: s, requested: wants, processing,
      // مجهول (null) يُعامل كمعالجة فعّالة (تحفّظًا)
      processingOn: Object.values(processing).some((v) => v !== false),
      honored: honored(s), inputLatencyKnown: typeof s.latency === 'number',
    };
    this.stream = stream; this.track = track;
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.capture, 0, 0);   // لا يُوصل بـ destination أبدًا
    this.micOn = true; this.micMuted = !!track.muted; this.digitalSilence = false;
    track.onended = () => this._onMicEnded();
    track.onmute = () => { this.micMuted = true; this._event('mic-muted', { message: DEVICE_MESSAGES.trackMuted }); this._markUnmeasurableRecent(0.3); };
    track.onunmute = () => { this.micMuted = false; this._event('mic-unmuted', {}); };
    if (!this._onDeviceChange) {
      this._onDeviceChange = () => this._emit('devices', {});
      navigator.mediaDevices.addEventListener?.('devicechange', this._onDeviceChange);
    }
    this._refreshLatency();
    this._newEpoch();
    this._event('mic-on', { label: track.label, settings: s, processingOn: this.trackInfo.processingOn, honored: this.trackInfo.honored });
    this._emit('state', this.status());
    return this.trackInfo;
  }

  async listDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label || 'ميكروفون', groupId: d.groupId }));
  }

  /** تبديل الجهاز أثناء الجلسة: يُوقف التشغيل ويُبطل المعايرة (الأرضية/الكمون يختلفان بين الأجهزة). */
  async switchMic(deviceId) {
    if (this.state === 'playing') await this._finish('device-switch');
    const info = await this.enableMic({ deviceId });
    this.calibration.done = false; this.leak.probed = false; this.leak.detected = false;
    this._event('device-switched', { label: info.label, message: 'تغيّر الميكروفون: أعد المعايرة للحصول على تقييم موثوق.' });
    this._emit('state', this.status());
    return info;
  }

  /**
   * للاختبار فقط (لا يُستعمل في الإنتاج): يستبدل الميكروفون بنسخة من المرجع نفسه قبل مقياس الصوت،
   * متأخرة delaySec ومضروبة بـ gain، ليُختبر المسار الكامل (عامل ← عامل طبقة ← جلسة ← مزامنة ← تقييم) بتأخير وسعة معروفين.
   * الحالة تُعلَّم synthetic:true ولا تُعدّ ميكروفونًا حقيقيًا ولا اختبار أداء بشري.
   */
  injectReferenceAsMic({ delaySec = 0, gain = 1, noiseDb = null } = {}) {
    this._releaseMic();
    const d = this.ctx.createDelay(5); d.delayTime.value = delaySec;
    const g = this.ctx.createGain(); g.gain.value = gain;
    this.src.connect(d).connect(g).connect(this.capture, 0, 0);
    this._inj = { d, g };
    if (noiseDb != null) {   // ضجيج غرفة مستقل (غاوسي) بمستوى RMS محدد؛ غير متماسك مع المرجع
      const len = this.ctx.sampleRate * 4, buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate), x = buf.getChannelData(0);
      const amp = 10 ** (noiseDb / 20);
      for (let i = 0; i < len; i++) { let u = 0; for (let k = 0; k < 6; k++) u += Math.random(); x[i] = (u - 3) * Math.SQRT2 * amp; } // ≈ غاوسي، RMS ≈ amp
      const n = this.ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.connect(this.capture, 0, 0); n.start();
      this._inj.n = n;
    }
    this.micOn = true; this.micMuted = false; this.digitalSilence = false;
    this.settings.headphones = true;
    this.trackInfo = { label: 'اختبار: نسخة من المرجع (ليست ميكروفونًا)', synthetic: true, deviceId: null, requested: {},
      settings: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0 },
      processing: { agc: false, ns: false, ec: false }, processingOn: false, honored: true, inputLatencyKnown: true };
    this._refreshLatency(); this._newEpoch();
    this._event('mic-on', { synthetic: true });
    return this.trackInfo;
  }

  _releaseMic() {
    try { this._inj?.g.disconnect(); this._inj?.d.disconnect(); this._inj?.n?.stop(); this._inj?.n?.disconnect(); } catch { /* */ }
    this._inj = null;
    try { this.micSource?.disconnect(); } catch { /* */ }
    if (this.track) { this.track.onended = this.track.onmute = this.track.onunmute = null; }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.micSource = this.stream = this.track = null;
    this.micOn = false;
  }

  async _onMicEnded() {
    this.micOn = false;
    this._event('mic-ended', { message: DEVICE_MESSAGES.trackEnded });
    if (this.state === 'playing') await this._finish('mic-ended');
    this._emit('state', this.status());
  }

  _onCtxState() {
    const st = this.ctx.state;
    this._event('ctx-state', { state: st });
    if ((st === 'suspended' || st === 'interrupted') && this.state === 'playing') {
      this._finish('ctx-suspended');
      this._event('ctx-suspended', { message: DEVICE_MESSAGES.ctxSuspended });
    }
  }

  _onMediaStall() {
    if (this.state !== 'playing') return;
    // توقف المشغّل (تخزين مؤقت): δ يتغير بمقدار التوقف ⇒ نفتح مقطعًا جديدًا عند الاستئناف
    this._event('media-stall', { at: this.audio.currentTime });
    this._stallPending = true;
  }

  // ───────────────────────── الأحداث/السجل ─────────────────────────
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _event(code, detail = {}) {
    const rec = { code, at: this.ctx ? this.ctx.currentTime : null, wall: Date.now(), ...detail };
    this.events.push(rec);
    if (this.events.length > 500) this.events.shift();
    this._emit('device', rec);
  }

  _newEpoch() {
    this.epoch++;
    this.worker?.postMessage({ type: 'reset', epoch: this.epoch });
    this._leakResults = [];
    this.leak.monitorHits = 0;
  }

  // ───────────────────────── معالجة رسائل العامل ─────────────────────────
  _onWorker(m) {
    switch (m.type) {
      case 'ready': this._workerReady?.(m); break;
      case 'frames': {
        if (m.epoch !== this.epoch) return;
        for (const f of m.mic) {
          if (this.micMuted || !this.micOn) f.unmeasurable = true;
          this.latest = f;
          this._pushTrail(f);
          this.collector?.(f);
          this.session.addMic(f);
        }
        for (const f of m.tap) this.session.addTap(f);
        break;
      }
      case 'leak': {
        if (m.epoch !== this.epoch) return;
        this._leakResults.push(m);
        if (m.level != null) {
          this.leak.monitorLevel = m.level;
          const plausible = m.lagMs >= 5 && m.lagMs <= 480;
          this.leak.monitorHits = m.level >= 0.5 && plausible ? this.leak.monitorHits + 1 : 0;
          // استمرار تطابق قوي (≥ 3 فحوص متتالية ≈ 6 ث) ⇒ تسرّب فعلي، لا مصادفة نغمة مشتركة
          if (this.leak.monitorHits >= 3 && !this.leak.detected) {
            this.leak.detected = true; this.leak.at = Date.now();
            this._event('leak-detected', { level: m.level, lagMs: m.lagMs, message: 'الميكروفون يلتقط صوت التسجيل. استعمل سماعات أو اخفض مستوى الاستماع؛ التقييم الرقمي معطّل حتى يزول التسرّب.' });
          }
        }
        this._emit('leak', m);
        break;
      }
      case 'mic-silence': {
        if (m.epoch !== this.epoch) return;
        this.digitalSilence = m.silent;
        if (m.silent) { this._markUnmeasurableRecent(1.1); this._event('digital-silence', { message: DEVICE_MESSAGES.digitalSilence }); }
        else this._event('digital-silence-end', {});
        break;
      }
      case 'discontinuity': {
        // انقطاع في تدفق العينات: نغلق المقطع ونفتح غيره (δ يُعاد قياسه) بدل لصق زمنين مختلفين
        this._event('discontinuity', { expected: m.expected, got: m.got });
        if (this.seg && this.state === 'playing') this._openSegment('discontinuity');
        break;
      }
      default: break;
    }
  }

  _markUnmeasurableRecent(sec) {
    const s = this.session.cur;
    if (!s || !s.mic.t.length) return;
    const tEnd = s.mic.t[s.mic.t.length - 1];
    for (let i = s.mic.t.length - 1; i >= 0 && s.mic.t[i] >= tEnd - sec; i--) s.mic.meas[i] = 0;
  }

  // ───────────────────────── التشغيل ─────────────────────────
  get duration() { return this.audio?.duration || this.ref.a.durationSec; }
  setListenVolume(v) {
    this.settings.listenVolume = Math.max(0, Math.min(1, v));
    this.listenGain?.gain.setTargetAtTime(this.settings.listenVolume, this.ctx.currentTime, 0.02);
  }
  setManualOffset(sec) { this.settings.manualSec = sec; this.latency.manualSec = sec; this._emit('state', this.status()); }
  setMode(mode) { this.settings.mode = mode === 'tolerant' ? 'tolerant' : 'strict'; this._emit('state', this.status()); }
  setComfortOffset(cents) { this.calibration.offsetCents = Math.round(cents); this._emit('state', this.status()); }

  _openSegment(reason) {
    this._refreshLatency();
    this.seg = this.session.newSegment(reason, { startCtx: this.ctx.currentTime });
    this.seg.guessDelta = this.ctx.currentTime - this.audio.currentTime;
    this.hints.reset();
    return this.seg;
  }

  /**
   * يبدأ التشغيل من startSec. scored=true ⇒ مقطع جلسة جديد (لا خلط مع ما قبله). لا يبدأ إلا باستدعاء من المستخدم.
   * reason: 'play' | 'seek' | 'restart-line' | 'resume' | 'leak-probe' ...
   */
  async play({ startSec, endSec = null, reason = 'play', scored = true } = {}) {
    if (!this.ctx) await this.init();
    await this.ctx.resume();
    this._stopTimers();
    this.audio.pause();
    this._newEpoch();
    this.session.closeSegment();
    this.seg = null;
    this.playRange = { startSec, endSec };
    this.collectTap = null;
    const dur = this.duration;
    this.audio.currentTime = Math.max(0, Math.min(dur - 0.05, startSec));
    if (scored && this.micOn) {
      if (!CONTINUATION.has(reason) || this.runFirstSegId == null) this.runFirstSegId = this.session.nextId;
      this.seg = this.session.newSegment(reason, { startCtx: this.ctx.currentTime });
    }
    this.hints.reset(); this.liveState = null;
    await this.audio.play();
    this._refreshLatency();
    if (this.seg) this.seg.guessDelta = this.ctx.currentTime - this.audio.currentTime;
    this.state = 'playing';
    this._stallPending = false;
    this._startTimers();
    this._emit('state', this.status());
    this._emit('play', { startSec, endSec, reason });
  }

  async pause() { if (this.state === 'playing') await this._finish('pause'); }

  async seek(sec) {
    if (this.state === 'playing') return this.play({ startSec: sec, endSec: this.playRange?.endSec ?? null, reason: 'seek' });
    this.audio.currentTime = Math.max(0, Math.min(this.duration, sec));
    this._emit('tick', { tRef: this.audio.currentTime });
    return undefined;
  }

  async _finish(reason) {
    if (this.state !== 'playing') return;
    this.state = 'finishing';
    this._stopTimers();
    this.audio.pause();
    this.capture?.port.postMessage({ type: 'flush' });
    await sleep(260);                       // تصل الإطارات المتأخرة (≈ تأخير التحليل + رسائل)
    this.session.closeSegment();
    this.state = 'ready';
    this.seg = null;
    this._emit('state', this.status());
    this._emit('ended', { reason, range: this.playRange });
  }

  // ───────────────────────── مؤقّتات التشغيل ─────────────────────────
  _startTimers() {
    this._lastAlign = performance.now(); this._lastLive = 0;
    this._timers.tick = setInterval(() => this._tick(), 50);
  }
  _stopTimers() { for (const k of Object.keys(this._timers)) { clearInterval(this._timers[k]); delete this._timers[k]; } }

  /** موضع المرجع الذي يسمعه المستخدم الآن (إن قِيس δ) وإلا موضع عنصر الصوت (تقريب ≤ بضع عشرات ms). */
  currentRefTime() {
    const s = this.seg;
    if (s && s.tracker.count) {
      const tc = this.ctx.currentTime;
      return tc - s.tracker.at(tc) - this.latency.outputSec;
    }
    return this.audio?.currentTime ?? 0;
  }

  _tick() {
    if (this.state !== 'playing') return;
    const now = performance.now();
    if (this._stallPending && !this.audio.paused && this.audio.readyState >= 3) {
      this._stallPending = false;
      if (this.seg) this._openSegment('media-resume');
    }
    const a = this.audio.currentTime;
    const tRef = this.currentRefTime();
    this._emit('tick', { tRef, media: a });
    const end = this.playRange?.endSec;
    if (end != null && a >= end + TAIL_SEC) { this._finish('range-end'); return; }
    if (this.seg && now - this._lastAlign >= 1000) {
      this._lastAlign = now;
      const r = this.session.tryAlign(this.ref);
      if (r) {
        this.sync = { delta: r.delta, corr: r.corr, count: this.seg.tracker.count, driftPpm: this.seg.tracker.driftPpm, lastOk: !!r.ok, lastReason: r.reason || (r.atBound ? 'at-bound' : null) };
        this._emit('align', { ...this.sync, atBound: !!r.atBound });
      }
    }
    if (this.seg && this.seg.tracker.count && now - this._lastLive >= 250) {
      this._lastLive = now;
      const lat = this.latency.snapshot();
      const user = this.session.userTrack(lat, { tStart: tRef - 3.6, tEnd: tRef + 0.2, segmentIds: [this.seg.id] });
      const live = computeLive(this.ref, user, { tNow: tRef, offsetCents: this.calibration.offsetCents, calibration: this.calSnapshot() });
      const hint = this.hints.update(live, now);
      this.liveState = { live, hint };
      this._emit('live', this.liveState);
    }
  }

  calSnapshot() { return { noiseFloorDb: this.calibration.noiseFloorDb, comfortLevelDb: this.calibration.comfortLevelDb }; }

  // ───────────────────────── المعايرة ─────────────────────────
  /** يجمع إطارات الميكروفون لمدة sec دون تشغيل المرجع. */
  async _collect(sec, onProgress, { skipSec = 0.2 } = {}) {
    if (!this.micOn) throw Object.assign(new Error('الميكروفون غير مفعّل'), { code: 'no-mic' });
    if (this.state === 'playing') await this._finish('calibration');
    this._newEpoch();
    const frames = [];
    let t0 = null;
    const done = new Promise((resolve) => {
      this.collector = (f) => {
        if (t0 == null) t0 = f.tCtx;
        const el = f.tCtx - t0;
        if (el >= skipSec) frames.push(f);
        onProgress?.(Math.min(1, el / sec), f);
        if (el >= sec) { this.collector = null; resolve(); }
      };
    });
    const guard = sleep((sec + 3) * 1000).then(() => { this.collector = null; });
    await Promise.race([done, guard]);
    this.collector = null;
    if (!frames.length) throw Object.assign(new Error('لا تصل إطارات من الميكروفون (تحقق من الجهاز).'), { code: 'no-frames' });
    return frames;
  }

  async measureNoise(sec = 2.5, onProgress) {
    const frames = await this._collect(sec, onProgress);
    const db = frames.map((f) => f.energyDb);
    const med = median(db), p95 = percentile(db, 95);
    if (this.digitalSilence || this.micMuted || med <= -110) {
      throw Object.assign(new Error(DEVICE_MESSAGES.digitalSilence), { code: 'digital-silence' });
    }
    // إن تكلّم المستخدم أثناء قياس الضجيج (إطارات مجهورة كثيرة أو مستوى عالٍ) لا نعتمد الوسيط أرضيةً؛ نأخذ أهدأ جزء
    const voicedFrac = frames.filter((f) => f.voiced).length / Math.max(1, frames.length);
    const contaminated = voicedFrac > 0.25 || med > -35;
    const floor = contaminated ? Math.min(percentile(db, 10), -45) : med;
    this.calibration.noiseFloorDb = floor;
    this.calibration.noiseP95Db = p95;
    const noisy = !contaminated && med > -40;
    this._event('calibration-noise', { noiseFloorDb: floor, medianDb: med, p95Db: p95, noisy, contaminated, voicedFrac });
    return { noiseFloorDb: floor, p95Db: p95, noisy, contaminated, frames: frames.length };
  }

  async measureVoice(sec = 6, onProgress) {
    const nf = this.calibration.noiseFloorDb ?? -70;
    const frames = await this._collect(sec, onProgress);
    // عتبة الصوت: فوق الضجيج بـ10 dB، لكن لا تتجاوز −42 dBFS حتى لا يُرفض صوت حقيقي بسبب أرضية ضجيج مرتفعة خطأً
    const thr = Math.min(nf + 10, -42);
    const v = frames.filter((f) => f.voiced && f.periodicity >= 0.5 && f.energyDb >= thr && Number.isFinite(f.f0));
    const voicedSec = v.length * ENGINE_PARAMS.hopSec;
    if (voicedSec < 1.5) {
      const maxDb = frames.length ? Math.max(...frames.map((f) => f.energyDb)) : -120;
      const anyVoiced = frames.filter((f) => f.voiced).length * ENGINE_PARAMS.hopSec;
      const err = new Error(`لم نسمع صوتًا كافيًا (مجهور ${voicedSec.toFixed(1)} ث، المطلوب 1.5 ث). أعلى مستوى التُقط ${maxDb.toFixed(0)} dB وأرضية الضجيج ${nf.toFixed(0)} dB؛ المجهور بلا شرط المستوى ${anyVoiced.toFixed(1)} ث. اقرأ بيتًا بصوت مريح قرب الميكروفون وأعد المحاولة.`);
      err.code = 'not-enough-voice'; err.voicedSec = voicedSec; err.maxDb = maxDb; err.anyVoicedSec = anyVoiced; throw err;
    }
    const cents = v.map((f) => 1200 * Math.log2(f.f0 / 100));
    const med = median(cents);
    const refMed = this.ref.stats?.medianCentsRe100Hz ?? this.ref.a.stats?.medianCentsRe100Hz ?? 0;
    const sug = suggestComfortOffset(med, refMed);
    Object.assign(this.calibration, {
      comfortLevelDb: median(v.map((f) => f.energyDb)), userMedianCents: med,
      rangeCents: { p10: percentile(cents, 10), p90: percentile(cents, 90) },
      suggestedOffsetCents: sug, offsetCents: sug, voicedSec,
    });
    this._event('calibration-voice', { comfortLevelDb: this.calibration.comfortLevelDb, userMedianCents: med, suggestedOffsetCents: sug, voicedSec });
    return { ...this.calibration };
  }

  /**
   * فحص التسرّب: المرجع يُشغَّل بمستوى الاستماع الحالي والمستخدم صامت. أي ارتباط متماسك (موجة-بموجة)
   * بين التقاط المرجع والميكروفون يعني أن الميكروفون يسمع المرجع ⇒ التقييم لا يمكن أن يُنسب لصوت المستخدم.
   */
  async probeLeak({ startSec = null, sec = 6, onProgress } = {}) {
    if (!this.micOn) throw Object.assign(new Error('الميكروفون غير مفعّل'), { code: 'no-mic' });
    const perf = this.ref.performance;
    const t0 = startSec ?? (perf ? perf.startSec + 8 : 10);
    this.worker.postMessage({ type: 'leak-enable', enabled: true });
    const frames = [];
    this.collector = (f) => { frames.push(f); };
    await this.play({ startSec: t0, endSec: null, reason: 'leak-probe', scored: false });
    const t1 = performance.now();
    while (performance.now() - t1 < sec * 1000) { onProgress?.(Math.min(1, (performance.now() - t1) / (sec * 1000))); await sleep(100); }
    const results = this._leakResults.filter((r) => r.level != null);
    await this._finish('leak-probe-end');
    this.collector = null;
    this.worker.postMessage({ type: 'leak-enable', enabled: false });
    const body = frames.filter((f) => f.tCtx - frames[0].tCtx > 1.0);
    const micProbeDb = body.length ? median(body.map((f) => f.energyDb)) : null;
    const nf = this.calibration.noiseFloorDb;
    const userSilent = micProbeDb != null && (nf == null || micProbeDb <= nf + 12);
    const level = results.length ? Math.max(...results.map((r) => r.level)) : null;
    const best = results.length ? results.reduce((a, b) => (b.level > a.level ? b : a)) : null;
    const comfort = this.calibration.comfortLevelDb;
    const relVoiceDb = micProbeDb != null && comfort != null ? micProbeDb - comfort : null;
    // التماسك موجة-بموجة مع المرجع لا يصدر عن صوت بشري مستقل: ارتباط قوي بتأخر معقول = تسرّب مهما كان صمت المستخدم.
    const strong = !!best && best.level >= 0.5 && best.lagMs >= 5 && best.lagMs <= 480;
    const coherent = level != null && level >= 0.2;
    // «لا تسرّب» لا يُستنتج إلا إذا كان المستخدم صامتًا فعلًا (وإلا قد يكون صوته قد غطّى على التسرّب)
    const valid = strong || (userSilent && level != null);
    const detected = valid && (strong || (coherent && (relVoiceDb == null ? micProbeDb > (nf ?? -70) + 20 : relVoiceDb >= LEAK_VIOLATION_REL_DB)));
    const weak = valid && coherent && !detected;
    Object.assign(this.leak, { probed: true, valid, level, lagMs: best?.lagMs ?? null, micProbeDb, relVoiceDb, detected, weak, monitorHits: 0, at: Date.now(), userSilent });
    this._event('leak-probe', { valid, userSilent, level, lagMs: best?.lagMs ?? null, micProbeDb, relVoiceDb, detected, weak, checks: results.length });
    this._emit('state', this.status());
    return { ...this.leak };
  }

  completeCalibration() {
    if (this.calibration.noiseFloorDb == null || this.calibration.comfortLevelDb == null) throw new Error('المعايرة ناقصة (الضجيج/مستوى الصوت)');
    this.calibration.done = true; this.calibration.at = Date.now();
    this._event('calibration-done', { ...this.calibration });
    this._emit('state', this.status());
  }

  // ───────────────────────── التقييم ─────────────────────────
  confidenceFor(res, { alignmentUnreliable = false } = {}) {
    return computeConfidence({
      headphones: this.settings.headphones,
      leak: { level: this.leak.probed && this.leak.valid ? this.leak.level : (this.leak.monitorLevel ?? null), detected: this.leak.detected },
      latencySource: this.latency.source, calibrated: this.calibration.done,
      measurableFraction: res?.measurableFraction ?? 0, processingOn: !!this.trackInfo?.processingOn,
      lagReliable: res?.lagReliable, alignmentUnreliable,
    });
  }

  /** يقيّم نافذة مرجعية [tStart,tEnd) من المقطع الأحدث الذي يغطّيها. */
  score(tStart, tEnd, { mode = this.settings.mode, alignmentUnreliable = false, segmentIds = null, allRuns = false } = {}) {
    const lat = this.latency.snapshot();
    // افتراضيًا تُقرأ مقاطع المحاولة الحالية فقط: إن فشل الجهاز في هذه المحاولة لا تُعاد بيانات محاولة أقدم بصمت.
    if (!segmentIds && !allRuns && this.runFirstSegId != null) segmentIds = this.session.segments.filter((x) => x.id >= this.runFirstSegId).map((x) => x.id);
    const user = this.session.userTrack(lat, { tStart: tStart - 0.8, tEnd: tEnd + 0.8, segmentIds });
    const res = scoreWindow(this.ref, user, { tStart, tEnd, mode, offsetCents: this.calibration.offsetCents, calibration: this.calSnapshot(), detail: true });
    res.segmentId = user.segmentId;
    res.latency = lat;
    res.confidence = this.confidenceFor(res, { alignmentUnreliable });
    if (!res.confidence.numericScoringAllowed) { res.numericScoreWithheld = res.overall; res.overall = null; res.overallReason = 'leak-violation'; }
    return res;
  }

  // ───────────────────────── الحالة/التنظيف ─────────────────────────
  status() {
    return {
      state: this.state, micOn: this.micOn, micMuted: this.micMuted, digitalSilence: this.digitalSilence,
      ctx: this.ctx ? { state: this.ctx.state, sampleRate: this.ctx.sampleRate, baseLatency: this.ctx.baseLatency ?? null, outputLatency: this.ctx.outputLatency ?? null } : null,
      analyzer: this.analyzerInfo || null,
      track: this.trackInfo ? { label: this.trackInfo.label, synthetic: !!this.trackInfo.synthetic, settings: this.trackInfo.settings, processing: this.trackInfo.processing, processingOn: this.trackInfo.processingOn, honored: this.trackInfo.honored, inputLatencyKnown: this.trackInfo.inputLatencyKnown } : null,
      settings: { ...this.settings }, calibration: { ...this.calibration }, leak: { ...this.leak }, sync: { ...this.sync },
      latency: this.latency.snapshot(),
    };
  }

  dispose() {
    this._stopTimers();
    this._releaseMic();
    if (this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._onDeviceChange) navigator.mediaDevices?.removeEventListener?.('devicechange', this._onDeviceChange);
    try { this.audio?.pause(); } catch { /* */ }
    try { this.capture?.disconnect(); this.src?.disconnect(); this.listenGain?.disconnect(); this.sink?.disconnect(); } catch { /* */ }
    this.worker?.terminate();
    this.ctx?.close?.();
    this.ctx = this.worker = this.audio = null;
    this.state = 'disposed';
  }
}
