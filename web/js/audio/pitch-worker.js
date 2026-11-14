// Worker: يحوّل كتل العينات إلى إطارات (طبقة/دورية/طاقة) للميكروفون ونسخة المرجع، ويكشف تسرّب المرجع إلى الميكروفون.
// لا يعتمد معدل الرسم على معدل التحليل: الإطارات تُجدول بإطارات السياق (انظر core/frames.js).
import { FrameAnalyzer } from '../core/frames.js';
import { normalizedXcorr } from '../core/dsp.js';

let mic = null, tap = null, params = null, ctxRate = 48000;
let epoch = 0, needReset = true, expectedFrame = null;
let zeroChunks = 0, digitalSilence = false;
// كشف التسرّب: حلقات 8kHz تقريبًا
let leak = { enabled: false, D: 6, ringMic: null, ringTap: null, w: 0, filled: 0, sinceCheck: 0 };
const LEAK_SEC = 3, LEAK_EVERY = 2, LEAK_LAG_SEC = 0.5;

function makeAnalyzers(rate) {
  const o = { ctxRate: rate, hopSec: params.hopSec, windowSec: params.windowSec, fmin: params.fmin, fmax: params.fmax };
  mic = new FrameAnalyzer(o);
  tap = new FrameAnalyzer(o);
}

function leakReset() {
  leak.D = Math.max(1, Math.round(ctxRate / 8000));
  const n = Math.round((LEAK_SEC * ctxRate) / leak.D);
  leak.ringMic = new Float32Array(n);
  leak.ringTap = new Float32Array(n);
  leak.w = 0; leak.filled = 0; leak.sinceCheck = 0; leak.acc = { m: 0, t: 0, c: 0 };
}

function leakPush(micBuf, tapBuf, n) {
  const D = leak.D;
  for (let i = 0; i < n; i++) {
    leak.acc.m += micBuf[i]; leak.acc.t += tapBuf[i]; leak.acc.c++;
    if (leak.acc.c === D) { // مرشّح صندوقي بسيط ثم خفض (كافٍ لإشارات ≤ 4kHz التي تحمل معظم طاقة الصوت)
      leak.ringMic[leak.w] = leak.acc.m / D; leak.ringTap[leak.w] = leak.acc.t / D;
      leak.w = (leak.w + 1) % leak.ringMic.length;
      leak.filled = Math.min(leak.filled + 1, leak.ringMic.length);
      leak.sinceCheck++;
      leak.acc.m = 0; leak.acc.t = 0; leak.acc.c = 0;
    }
  }
  const rate = ctxRate / D;
  if (leak.enabled && leak.filled === leak.ringMic.length && leak.sinceCheck >= LEAK_EVERY * rate) {
    leak.sinceCheck = 0;
    const n2 = leak.ringMic.length, a = new Float32Array(n2), b = new Float32Array(n2);
    for (let i = 0; i < n2; i++) { a[i] = leak.ringTap[(leak.w + i) % n2]; b[i] = leak.ringMic[(leak.w + i) % n2]; }
    let ea = 0, eb = 0;
    for (let i = 0; i < n2; i++) { ea += a[i] * a[i]; eb += b[i] * b[i]; }
    const tapDb = 10 * Math.log10(Math.max(ea / n2, 1e-12)), micDb = 10 * Math.log10(Math.max(eb / n2, 1e-12));
    if (tapDb < -50 || micDb < -100) { postMessage({ type: 'leak', epoch, level: null, reason: tapDb < -50 ? 'reference-silent' : 'mic-silent', tapDb, micDb }); return; }
    const r = normalizedXcorr(a, b, Math.round(LEAK_LAG_SEC * rate));
    postMessage({ type: 'leak', epoch, level: Math.max(0, r.bestCorr), lagMs: (r.bestLag / rate) * 1000, tapDb, micDb });
  }
}

onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      params = m.params; ctxRate = m.ctxRate; makeAnalyzers(ctxRate); leakReset(); epoch = m.epoch ?? 0; needReset = true;
      postMessage({ type: 'ready', ctxRate, effectiveRate: mic.sr, decimation: mic.D, geometry: mic.g });
      break;
    case 'reset':
      epoch = m.epoch; needReset = true; zeroChunks = 0; digitalSilence = false; leakReset();
      break;
    case 'leak-enable':
      leak.enabled = !!m.enabled; leakReset();
      break;
    case 'chunk': {
      if (!mic) return;
      const micBuf = new Float32Array(m.mic, 0, m.n), tapBuf = new Float32Array(m.tap, 0, m.n);
      if (needReset || (expectedFrame != null && m.frame0 !== expectedFrame)) {
        if (!needReset) postMessage({ type: 'discontinuity', epoch, expected: expectedFrame, got: m.frame0 });
        mic.reset(m.frame0); tap.reset(m.frame0); leakReset();
        needReset = false;
      }
      expectedFrame = m.frame0 + m.n;
      // صمت رقمي كامل من الميكروفون (مكتوم/غير موصول) أو لا مدخل
      const silent = !m.micPresent || m.micMaxAbs === 0;
      zeroChunks = silent ? zeroChunks + 1 : 0;
      const nowSilent = zeroChunks * m.n / ctxRate > 1.0;
      if (nowSilent !== digitalSilence) { digitalSilence = nowSilent; postMessage({ type: 'mic-silence', epoch, silent: nowSilent, micPresent: m.micPresent }); }
      const mf = mic.push(micBuf), tf = tap.push(tapBuf);
      if (digitalSilence || !m.micPresent) for (const f of mf) f.unmeasurable = true;
      postMessage({ type: 'frames', epoch, mic: mf, tap: tf.map((f) => ({ k: f.k, tCtx: f.tCtx, energyDb: f.energyDb })) });
      leakPush(micBuf, tapBuf, m.n);
      break;
    }
  }
};
