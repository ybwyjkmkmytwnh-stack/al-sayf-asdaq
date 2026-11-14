// العلاقة الزمنية الصريحة بين: موضع المرجع، ساعة السياق، إطار الميكروفون، تأخير الإدخال/الإخراج، وتأخير تحليل النافذة.
//
// ── اصطلاح الإشارة (موحَّد في كل المشروع) ─────────────────────────────────────────────
//  δ  (delta)  = tCtx_graph − tRef : زمن السياق الذي يمرّ فيه موضع المرجع tRef عبر «رسم الصوت» (نقطة الالتقاط
//                قبل مقياس الصوت). يُقاس من التقاط المرجع نفسه (tap) ومقارنة غلاف طاقته بالتحليل المسبق.
//  L_out       : تأخير مسار الإخراج من الرسم إلى أذن المستخدم (baseLatency+outputLatency + تقدير أكوستيكي).
//  L_in        : تأخير مسار الإدخال من فم المستخدم إلى وصول العينة في الرسم (track.getSettings().latency).
//  manual      : إزاحة يدوية (ث). موجبة = «صوتي يتأخر عن الموضع المفترض»، فنقارنه بموضع مرجعي أبكر.
//  إطار ميكروفون بمركز tCtx ⇒ ما سمعه المستخدم حين غنّى = موضع المرجع:
//        tRef = tCtx − δ − (L_in + L_out + manual)            (1)
//  «تأخير التحليل» (L/2 ≈ 28–40 ms) لا يدخل (1) لأن ختم الإطار هو مركزه لا لحظة جاهزيته.
//  زمن رد الفعل البشري ليس تأخير جهاز: لا يُضاف تلقائيًا؛ للمستخدم ضبط manual.

export const SIGN_CONVENTION_AR =
  'tRef = tCtx − δ − (L_in + L_out + manual). تأخير إيجابي في الصوت (المستخدم متأخر) يظهر خطأ توقيت موجبًا.';

export function refTimeForMic(tCtx, delta, latency) {
  return tCtx - delta - (latency.inputSec + latency.outputSec + latency.manualSec);
}

export class LatencyModel {
  constructor({ baseLatency = 0, outputLatency = 0, inputLatency = 0, manualSec = 0, measuredLoopbackSec = null } = {}) {
    this.baseLatency = baseLatency;
    this.outputLatency = outputLatency;
    this.inputLatency = inputLatency;
    this.manualSec = manualSec;
    this.measuredLoopbackSec = measuredLoopbackSec;
  }
  get outputSec() { return this.measuredLoopbackSec != null ? Math.max(0, this.measuredLoopbackSec - this.inputLatency) : this.baseLatency + this.outputLatency; }
  get inputSec() { return this.inputLatency; }
  get totalSec() { return this.inputSec + this.outputSec + this.manualSec; }
  get source() { return this.measuredLoopbackSec != null ? 'measured-loopback' : 'reported-estimate'; }
  snapshot() { return { inputSec: this.inputSec, outputSec: this.outputSec, manualSec: this.manualSec, totalSec: this.totalSec, source: this.source }; }
}

function interpEnergy(refDb, hop, tRef) {
  const x = tRef / hop;
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= refDb.length) return NaN;
  const f = x - i;
  return refDb[i] * (1 - f) + refDb[i + 1] * f;
}

/**
 * يقدّر δ بمطابقة غلاف طاقة المرجع الملتقَط (tap) مع طاقة التحليل المسبق.
 *  tapT[k] (زمن سياق مركز الإطار)، tapDb[k] (طاقة dB). refDb بخطوة hop. guessDelta = تخمين أولي (من audio.currentTime).
 * يعيد {delta, corr, n, ok}.  ok إن corr ≥ minCorr وعدد إطارات كافٍ.
 */
export function alignTapToReference(tapT, tapDb, refDb, hop, timeOrigin, guessDelta, { searchSec = 1.5, stepSec = 0.0025, minCorr = 0.8, minDb = -70 } = {}) {
  const n = tapT.length;
  const useIdx = [];
  for (let k = 0; k < n; k++) if (tapDb[k] > minDb) useIdx.push(k);
  if (useIdx.length < 40) return { delta: guessDelta, corr: NaN, n: useIdx.length, ok: false, reason: 'no-signal' };
  const steps = Math.round((2 * searchSec) / stepSec);
  const corrs = new Float64Array(steps + 1);
  const ys = new Float64Array(useIdx.length);
  let my = 0;
  for (let j = 0; j < useIdx.length; j++) { ys[j] = tapDb[useIdx[j]]; my += ys[j]; }
  my /= useIdx.length;
  let vy = 0;
  for (let j = 0; j < ys.length; j++) vy += (ys[j] - my) ** 2;
  let best = -2, bi = 0;
  const xs = new Float64Array(useIdx.length);
  for (let s = 0; s <= steps; s++) {
    const d = guessDelta - searchSec + s * stepSec;
    let mx = 0, cnt = 0;
    for (let j = 0; j < useIdx.length; j++) {
      const v = interpEnergy(refDb, hop, tapT[useIdx[j]] - d - timeOrigin);
      xs[j] = v;
      if (Number.isFinite(v)) { mx += v; cnt++; }
    }
    if (cnt < 40) { corrs[s] = -2; continue; }
    mx /= cnt;
    let sxy = 0, sxx = 0, syy = 0;
    for (let j = 0; j < useIdx.length; j++) {
      if (!Number.isFinite(xs[j])) continue;
      const a = xs[j] - mx, b = ys[j] - my;
      sxy += a * b; sxx += a * a; syy += b * b;
    }
    const c = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : -2;
    corrs[s] = c;
    if (c > best) { best = c; bi = s; }
  }
  let delta = guessDelta - searchSec + bi * stepSec;
  if (bi > 0 && bi < steps) {
    const y0 = corrs[bi - 1], y1 = corrs[bi], y2 = corrs[bi + 1];
    const den = y0 - 2 * y1 + y2;
    if (Math.abs(den) > 1e-12) delta += (0.5 * (y0 - y2) / den) * stepSec;
  }
  return { delta, corr: best, n: useIdx.length, ok: best >= minCorr, atBound: bi === 0 || bi === steps };
}

/**
 * متتبّع δ عبر الزمن: يخزّن قياسات (tCtx, δ) ويعطي δ(t) بانحدار خطي مقاوم (لكشف الانجراف طويل الأمد).
 * إن لم يوجد قياس صالح يعيد null (لا نخترع قيمة).
 */
export class DeltaTracker {
  constructor() { this.pts = []; }
  reset() { this.pts = []; }
  add(tCtx, delta, corr) { this.pts.push({ t: tCtx, d: delta, c: corr }); if (this.pts.length > 64) this.pts.shift(); }
  get count() { return this.pts.length; }
  /** انحدار خطي بالمربعات الصغرى على آخر القياسات؛ ينحدر فقط إن وُجدت ≥ 3 قياسات تمتد ≥ 20 ث. */
  at(t) {
    const p = this.pts;
    if (!p.length) return null;
    if (p.length < 3 || p[p.length - 1].t - p[0].t < 20) return p[p.length - 1].d;
    let st = 0, sd = 0;
    for (const q of p) { st += q.t; sd += q.d; }
    const mt = st / p.length, md = sd / p.length;
    let num = 0, den = 0;
    for (const q of p) { num += (q.t - mt) * (q.d - md); den += (q.t - mt) ** 2; }
    const slope = den > 0 ? num / den : 0;
    return md + slope * (t - mt);
  }
  get driftPpm() {
    const p = this.pts;
    if (p.length < 3) return 0;
    const a = p[0], b = p[p.length - 1];
    return b.t > a.t ? ((b.d - a.d) / (b.t - a.t)) * 1e6 : 0;
  }
}
