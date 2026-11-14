// تقييم تشابه الأداء الصوتي — متعدد الأبعاد، شفاف، وبلا نقاط مجانية.
//
// النطاق (يُعرض للمستخدم كما هو): «تقييم تشابه الأداء الصوتي». لا يقيّم النطق ولا الحركات ولا العروض اللفظي،
// وأي وزن/عتبة هنا «تجريبي» لم يُعايَر على بيانات بشرية (انظر DEFAULT_SCORING والتقرير).
//
// مبادئ:
//  1) الغياب يُحتسب صفرًا (التقييم مشمول بالتغطية)، أما «غير قابل للقياس» (فشل جهاز/استقرار/فلش) فيُستبعد ويُعلَن.
//  2) صمت المرجع ليس نقاط طبقة مجانية: الطبقة تُقاس فقط على إطارات المرجع المجهورة الصالحة.
//  3) الوقفات لا تُمنح إلا إذا كان المستخدم نشطًا قبلها وبعدها.
//  4) القوة نسبية إلى مستوى معايرة المستخدم (لا تطبيع لكل إطار) وتُمنح فقط حين الطبقة قريبة من اللحن (لا مكافأة لصوت خاطئ عالٍ).
//  5) الفرق بين الوضع الصارم والمتسامح: الصارم يقارن عند موضع المرجع بعد تعويض التأخير فقط؛ المتسامح يسمح بإزاحة محلية
//     محدودة (±maxLagSec) في مقارنة الطبقة لكن خطأ التوقيت يبقى ظاهرًا ومحسوبًا.

export const SCOPE = Object.freeze({
  assessment: 'performance-similarity',
  label: 'تقييم تشابه الأداء الصوتي',
  pronunciationAssessed: false,
  harakatAssessed: false,
  prosodyAssessed: false,
  note: 'التقييم يقيس تشابه اللحن والتوقيت والقوة مع التسجيل المرجعي ولا يتحقق من النطق أو الحركات أو العروض. الدندنة بنفس اللحن قد تنال تشابهًا لحنيًا عاليًا.',
});

export const DEFAULT_SCORING = Object.freeze({
  experimental: true,
  smoothFrames: 9,
  pitchFullCents: 50, pitchZeroCents: 300,
  timingFullSec: 0.10, timingZeroSec: 0.40, onsetSearchSec: 0.5,
  pauseSilentFraction: 0.6, pauseGuardSec: 0.5, pauseActivityMin: 0.3, pauseMinSec: 0.15,
  dynFullDb: 4, dynZeroDb: 12, dynGatePitchCents: 300, dynSmoothSec: 0.3,
  minPitchQuality: 0.35, userVoicedPeriodicity: 0.5,
  maxLagSec: 0.3, lagStepFrames: 2,
  onsetRiseDb: 8, onsetWithinSec: 0.08, onsetVoicedWithinSec: 0.12,
  refSilentDb: -40,
  weights: Object.freeze({ pitch: 0.45, timing: 0.25, pauses: 0.15, dynamics: 0.15 }),
  minMeasurableSec: 2.0,
});

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const tol = (e, full, zero) => { const a = Math.abs(e); return a <= full ? 1 : a >= zero ? 0 : 1 - (a - full) / (zero - full); };

/** وسيط منزلق يتجاهل NaN؛ القيمة NaN تبقى NaN. */
export function medianSmooth(x, win) {
  const n = x.length, h = win >> 1, out = new Float32Array(n).fill(NaN);
  const buf = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i])) continue;
    buf.length = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) if (Number.isFinite(x[j])) buf.push(x[j]);
    buf.sort((a, b) => a - b);
    out[i] = buf.length % 2 ? buf[buf.length >> 1] : 0.5 * (buf[buf.length / 2 - 1] + buf[buf.length / 2]);
  }
  return out;
}

/** جودة الطبقة للمستخدم: دورية × استمرارية (يطابق pitch_quality في pipeline.py). */
export function pitchQualityArray(f0, voiced, periodicity, { nb = 3, full = 100, zero = 400, isoPen = 0.5 } = {}) {
  const n = f0.length;
  const cents = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (voiced[i] && Number.isFinite(f0[i])) cents[i] = 1200 * Math.log2(f0[i] / 100);
  const q = new Float32Array(n).fill(NaN);
  const buf = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(cents[i])) continue;
    buf.length = 0;
    for (let j = Math.max(0, i - nb); j <= Math.min(n - 1, i + nb); j++) if (Number.isFinite(cents[j])) buf.push(cents[j]);
    buf.sort((a, b) => a - b);
    const med = buf.length % 2 ? buf[buf.length >> 1] : 0.5 * (buf[buf.length / 2 - 1] + buf[buf.length / 2]);
    let cont = clamp01(1 - (Math.abs(cents[i] - med) - full) / (zero - full));
    if (buf.length < 3) cont *= isoPen;
    q[i] = (Number.isFinite(periodicity[i]) ? periodicity[i] : 0) * cont;
  }
  return q;
}

/** كاشف البدايات (يطابق segments.detect_onsets): ارتفاع طاقة ≥ rise خلال within بعد انخفاض. يعيد [{timeSec, riseDb, voiced}]. */
export function detectOnsets(db, voiced, hop, i0 = 0, i1 = db.length, { riseDb = 8, withinSec = 0.08 } = {}) {
  const k = Math.max(1, Math.round(withinSec / hop));
  const out = [];
  const hi = Math.min(db.length - k - 1, i1);
  let i = Math.max(i0, 1);
  while (i < hi) {
    if (db[i + k] - db[i] >= riseDb && db[i] < db[i - 1] + 1.0) {
      let j = i;
      while (j < hi && db[j + 1] >= db[j] - 0.3) j++;
      out.push({ i: (i + j) / 2, riseDb: db[j] - db[i], voiced: !!voiced[Math.min(j, voiced.length - 1)] });
      i = j + 1;
    } else i++;
  }
  return out;
}

/**
 * يعيد عينات المستخدم (بزمن مرجعي) إلى شبكة المرجع [i0,i1).
 * user: {t:Float64Array (ث مرجعية), f0, periodicity, energyDb, voiced:Uint8, measurable:Uint8}
 * الإطار غير القابل للقياس يبقى meas=0؛ لا يُملأ بالاستيفاء.
 */
export function resampleUserToGrid(ref, user, i0, i1) {
  const n = i1 - i0, hop = ref.hop;
  const g = {
    n, i0, hop, f0: new Float32Array(n).fill(NaN), periodicity: new Float32Array(n), db: new Float32Array(n).fill(-120),
    voiced: new Uint8Array(n), meas: new Uint8Array(n), dist: new Float32Array(n).fill(Infinity),
  };
  const tol_ = 1.05 * hop;
  for (let j = 0; j < user.t.length; j++) {
    const x = (user.t[j] - ref.timeOrigin) / hop - i0;
    const i = Math.round(x);
    if (i < 0 || i >= n) continue;
    const d = Math.abs(x - i) * hop;
    if (d > tol_ || d >= g.dist[i]) continue;
    g.dist[i] = d;
    g.meas[i] = user.measurable[j] ? 1 : 0;
    g.f0[i] = user.f0[j];
    g.periodicity[i] = user.periodicity[j];
    g.db[i] = user.energyDb[j];
    g.voiced[i] = user.voiced[j] ? 1 : 0;
  }
  return g;
}

function userCents(g, opts) {
  const q = pitchQualityArray(g.f0, g.voiced, g.periodicity);
  const c = new Float32Array(g.n).fill(NaN);
  const ok = new Uint8Array(g.n);
  for (let i = 0; i < g.n; i++) {
    if (g.meas[i] && g.voiced[i] && Number.isFinite(g.f0[i]) && q[i] >= opts.minPitchQuality && g.periodicity[i] >= opts.userVoicedPeriodicity) {
      c[i] = 1200 * Math.log2(g.f0[i] / 100);
      ok[i] = 1;
    }
  }
  return { cents: medianSmooth(c, opts.smoothFrames), ok };
}

/** تقدير الإزاحة المحلية المحدودة (إطارات). lag>0 = المستخدم متأخر. */
function estimateLag(R, U, opts, offset) {
  const maxL = Math.round(opts.maxLagSec / R.hop), step = opts.lagStepFrames;
  let best = -Infinity, bestL = 0;
  const J = [];
  for (let l = -maxL; l <= maxL; l += step) {
    let s = 0;
    for (let i = 0; i < R.n; i++) {
      const j = i + l;
      if (j < 0 || j >= U.n || !U.meas[j]) continue;
      if (R.pv[i]) {
        if (U.ok[j]) s += 0.4 + 0.6 * tol(U.cents[j] - R.cents[i] - offset, opts.pitchFullCents, opts.pitchZeroCents);
      } else if (R.pause[i] && U.voiced[j]) s -= 0.5;
    }
    J.push([l, s]);
    if (s > best) { best = s; bestL = l; }
  }
  const sorted = J.map((p) => p[1]).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const atBound = Math.abs(bestL) >= maxL - step;
  const margin = best > 0 ? (best - median) / best : 0;
  return { lag: bestL, atBound, margin, reliable: !atBound && margin > 0.1 };
}


/**
 * إزاحة التوقيت العامة من ارتباط غلاف الطاقة «المجهورة فقط» (المرجع مقابل المستخدم) ضمن ±maxLag.
 * lag>0 = المستخدم متأخر. الغلاف المقيَّد بالجهر لا يتأثر بالضجيج/التصفيق. يعيد {lagFrames, corr, reliable}.
 */
export function envelopeLag(R, rEnergy, U, g, maxLagFrames) {
  const n = R.n;
  const a = new Float32Array(n), b = new Float32Array(n);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    a[i] = R.pv[i] ? Math.max(-50, Math.min(0, rEnergy[i])) : -50;
    b[i] = U.ok[i] ? Math.max(-50, Math.min(0, g.db[i])) : -50;
    ma += a[i]; mb += b[i];
  }
  ma /= n; mb /= n;
  for (let i = 0; i < n; i++) { a[i] -= ma; b[i] -= mb; }
  let best = -2, bl = 0;
  const cs = new Float64Array(2 * maxLagFrames + 1);
  for (let l = -maxLagFrames; l <= maxLagFrames; l++) {
    let sxy = 0, sxx = 0, syy = 0, cnt = 0;
    for (let i = Math.max(0, -l); i < Math.min(n, n - l); i++) {
      const j = i + l;
      if (!g.meas[j]) continue;
      sxy += a[i] * b[j]; sxx += a[i] * a[i]; syy += b[j] * b[j]; cnt++;
    }
    const c = cnt > 0.6 * n && sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : -2;
    cs[l + maxLagFrames] = c;
    if (c > best) { best = c; bl = l; }
  }
  let lagF = bl;
  const k = bl + maxLagFrames;
  if (k > 0 && k < cs.length - 1) {
    const y0 = cs[k - 1], y1 = cs[k], y2 = cs[k + 1], den = y0 - 2 * y1 + y2;
    if (Math.abs(den) > 1e-12) lagF = bl + 0.5 * (y0 - y2) / den;
  }
  return { lagFrames: lagF, corr: best, reliable: best >= 0.25 && Math.abs(bl) < maxLagFrames };
}

/**
 * التقييم الرئيسي لنافذة مرجعية [tStart, tEnd).
 *  ref: ReferenceData، user: انظر resampleUserToGrid.
 *  opts: {mode:'strict'|'tolerant', offsetCents, calibration:{noiseFloorDb, comfortLevelDb}, scoring:{...override}}
 */
export function scoreWindow(ref, user, opts = {}) {
  const S = { ...DEFAULT_SCORING, ...(opts.scoring || {}) };
  const mode = opts.mode === 'tolerant' ? 'tolerant' : 'strict';
  const offset = Number.isFinite(opts.offsetCents) ? opts.offsetCents : 0;
  const hop = ref.hop;
  const i0 = Math.max(0, ref.idx(opts.tStart)), i1 = Math.min(ref.n, ref.idx(opts.tEnd));
  const n = i1 - i0;
  const cal = opts.calibration || {};
  const refMed = ref.stats?.energyDbVoiced?.p50 ?? -9;
  const comfort = Number.isFinite(cal.comfortLevelDb) ? cal.comfortLevelDb : null;
  // «خمول» المستخدم في وقفة: طاقته دون الأعلى من (أرضية الضجيج+12) و(مستوى الراحة−12 dB). (لا نشترط عدم الجهر: وقفات المرجع انخفاضات طاقة قد تبقى مجهورة.)
  // وقفات المرجع «انخفاضات نسبية» (≥15 dB تحت خط الأساس) لا صمت مطلق، فنقيسها نسبيًا لمستوى المستخدم نفسه.
  const userActiveDb = Math.max(Number.isFinite(cal.noiseFloorDb) ? cal.noiseFloorDb + 12 : -45, (comfort ?? refMed) - 12);

  const out = { scope: SCOPE, mode, window: { tStart: opts.tStart, tEnd: opts.tEnd, frames: Math.max(0, n) }, offsetCents: offset, experimental: true };
  if (n <= 0) return { ...out, overall: null, overallReason: 'empty-window' };

  const g = resampleUserToGrid(ref, user, i0, i1);
  const U = userCents(g, S);
  U.n = n; U.meas = g.meas; U.voiced = g.voiced;
  const Rc = medianSmooth(ref.cents.subarray(i0, i1), S.smoothFrames);
  const R = { n, hop, cents: Rc, pv: new Uint8Array(n), pause: new Uint8Array(n) };
  let nRefVoiced = 0;
  for (let i = 0; i < n; i++) {
    if (ref.usablePitch(i0 + i) && Number.isFinite(Rc[i])) { R.pv[i] = 1; nRefVoiced++; }
  }
  for (const p of ref.pauses) {
    const a = ref.idx(p.startSec) - i0, b = ref.idx(p.endSec) - i0;
    for (let i = Math.max(0, a); i < Math.min(n, b); i++) R.pause[i] = 1;
  }

  // ── قابلية القياس
  let nMeas = 0;
  for (let i = 0; i < n; i++) nMeas += g.meas[i];
  out.measurableFraction = nMeas / n;
  const measurableSec = nMeas * hop;
  out.window.refVoicedSec = nRefVoiced * hop;
  out.window.measurableSec = measurableSec;
  if (nRefVoiced * hop < 1.0) return { ...out, overall: null, overallReason: 'no-scorable-reference' };
  if (measurableSec < S.minMeasurableSec) return { ...out, overall: null, overallReason: 'insufficient-measurable' };

  // ── الإزاحة المحلية
  let lagFrames = 0, lagInfo = { lag: 0, atBound: false, margin: 0, reliable: true };
  if (mode === 'tolerant') { lagInfo = estimateLag(R, U, S, offset); lagFrames = lagInfo.lag; }
  out.lagSec = lagFrames * hop;
  out.lagReliable = lagInfo.reliable;
  out.lagAtBound = lagInfo.atBound;

  // ── الطبقة
  let sum = 0, den = 0, matched = 0, absent = 0, unmeas = 0;
  const errs = [];
  const errTrack = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!R.pv[i]) continue;
    const j = i + lagFrames;
    if (j < 0 || j >= n || !g.meas[j]) { unmeas++; continue; }
    den++;
    if (U.ok[j]) {
      const e = U.cents[j] - Rc[i] - offset;
      errTrack[i] = e;
      errs.push(e);
      sum += tol(e, S.pitchFullCents, S.pitchZeroCents);
      matched++;
    } else absent++;
  }
  const pitchScore = den > 0 ? sum / den : null;
  const sortedAbs = errs.map(Math.abs).sort((a, b) => a - b);
  const sortedErr = errs.slice().sort((a, b) => a - b);
  out.pitch = {
    score: pitchScore, coverage: den > 0 ? matched / den : 0, matchedFrames: matched, absentFrames: absent, unmeasurableFrames: unmeas,
    medianErrCents: sortedErr.length ? sortedErr[sortedErr.length >> 1] : null,
    p90AbsErrCents: sortedAbs.length ? sortedAbs[Math.floor(0.9 * (sortedAbs.length - 1))] : null,
  };
  out.coverage = out.pitch.coverage;

  // ── التوقيت: إزاحة عامة (غلاف) + دقة بدايات محلية بعد إزالتها + ثبات المدود
  const env = envelopeLag(R, ref.energyDb.subarray(i0, i1), U, g, Math.round(0.6 / hop));
  const offsetSec = env.reliable ? env.lagFrames * hop : 0;
  const offFrames = env.reliable ? Math.round(env.lagFrames) : 0;
  const uOn = detectOnsets(g.db, g.voiced, hop, 0, n, { riseDb: S.onsetRiseDb, withinSec: S.onsetWithinSec })
    .filter((o) => {
      // يجب أن يتبع البدايةَ جهرٌ خلال onsetVoicedWithinSec (الهتاف/التصفيق بلا جهر لا يُحتسب)
      const a = Math.round(o.i), b = Math.min(n - 1, a + Math.round(S.onsetVoicedWithinSec / hop));
      for (let q = a; q <= b; q++) if (U.ok[q]) return true;
      return false;
    });
  const rOn = ref.onsets.filter((o) => o.voiced && o.timeSec >= opts.tStart && o.timeSec < opts.tEnd);
  const used = new Set();
  let onSum = 0, onDen = 0, onMatched = 0;
  const onRes = [];
  const sr = Math.round(0.15 / hop); // بحث محلي ضيّق حول الموضع المُزاح: يمنع الالتباس مع البداية المجاورة
  for (const r of rOn) {
    const ri = ref.idx(r.timeSec) - i0 + offFrames;
    let m = 0, t = 0;
    for (let q = Math.max(0, ri - sr); q < Math.min(n, ri + sr); q++) { m += g.meas[q]; t++; }
    if (t === 0 || m / t < 0.5) continue;
    let bestK = -1, bestD = Infinity;
    for (let k = 0; k < uOn.length; k++) {
      if (used.has(k)) continue;
      const d = uOn[k].i - ri;
      if (Math.abs(d) <= sr && Math.abs(d) < Math.abs(bestD)) { bestD = d; bestK = k; }
    }
    onDen++;
    if (bestK >= 0) {
      used.add(bestK);
      const e = bestD * hop;
      onRes.push(e);
      onSum += tol(e, 0.04, 0.15);
      onMatched++;
    }
  }
  // مدود (ثبات المستخدم داخل المدّ المرجعي، مع نفس الإزاحة المسموحة في الوضع المتسامح)
  const rSus = ref.sustains.filter((s) => s.startSec >= opts.tStart && s.endSec <= opts.tEnd);
  let suSum = 0, suDen = 0;
  const suRatios = [];
  for (const s of rSus) {
    const a = ref.idx(s.startSec) - i0, b = ref.idx(s.endSec) - i0;
    let m = 0;
    for (let q = Math.max(0, a + lagFrames); q < Math.min(n, b + lagFrames); q++) m += g.meas[q];
    if (m < 0.5 * (b - a)) continue;
    const holds = (q) => {
      const j = q + lagFrames;
      return j >= 0 && j < n && g.voiced[j] && U.ok[j] && Math.abs(U.cents[j] - Rc[q] - offset) <= S.dynGatePitchCents;
    };
    let run = 0, bestRun = 0, gap = 0;
    for (let q = Math.max(0, a); q < Math.min(n, b); q++) {
      if (holds(q)) { run += 1 + gap; gap = 0; bestRun = Math.max(bestRun, run); } else { gap++; if (gap > 6) { run = 0; gap = 0; } }
    }
    const ratio = clamp01(bestRun / Math.max(1, b - a));
    suRatios.push(ratio);
    suSum += ratio; suDen++;
  }
  const onsetLocal = onDen > 0 ? onSum / onDen : null;           // دقة البدايات المحلية بعد إزالة الإزاحة العامة
  // عقوبة الإزاحة العامة تضرب بُعد التوقيت كله (تبقى ظاهرة دومًا حتى في الوضع المتسامح). إزاحة غير موثوقة (لا ارتباط) = 0: لا نقاط بلا دليل.
  const offsetScore = env.reliable ? tol(offsetSec, S.timingFullSec, S.timingZeroSec) : 0;
  const onsetScore = onsetLocal;
  const sustainScore = suDen > 0 ? suSum / suDen : null;
  let core = null;
  if (onsetLocal != null && sustainScore != null) core = 0.65 * onsetLocal + 0.35 * sustainScore;
  else core = onsetLocal ?? sustainScore;
  const timingScore = core == null ? null : offsetScore * core;
  const med = (arr) => (arr.length ? arr.slice().sort((x, y) => x - y)[arr.length >> 1] : null);
  out.timing = {
    score: timingScore, onsetScore, onsetLocalScore: onsetLocal, offsetScore, sustainScore,
    offsetSec, offsetReliable: env.reliable, offsetCorr: env.corr,
    matchedOnsets: onMatched, totalOnsets: onDen, extraOnsets: Math.max(0, uOn.length - onMatched),
    medianOnsetResidualSec: med(onRes), sustainRatioMedian: med(suRatios), sustains: suDen,
  };

  // ── الوقفات (بحارس نشاط)
  let pSum = 0, pDen = 0, noAct = 0;
  const guard = Math.round(S.pauseGuardSec / hop);
  for (const p of ref.pauses) {
    if (p.durationSec < S.pauseMinSec || p.startSec < opts.tStart || p.endSec > opts.tEnd) continue;
    const a = ref.idx(p.startSec) - i0 + lagFrames, b = ref.idx(p.endSec) - i0 + lagFrames;
    const a2 = a + 3, b2 = b - 3;
    if (b2 <= a2) continue;
    let meas = 0, silent = 0;
    for (let q = Math.max(0, a2); q < Math.min(n, b2); q++) { if (g.meas[q]) { meas++; if (g.db[q] <= userActiveDb) silent++; } }
    if (meas < 0.5 * (b2 - a2)) continue;
    const act = (x, y) => { let c = 0, m = 0; for (let q = Math.max(0, x); q < Math.min(n, y); q++) { if (g.meas[q]) { m++; c += g.voiced[q]; } } return m ? c / m : 0; };
    const before = act(a - guard, a - 5), after = act(b + 5, b + guard);
    pDen++;
    if (before >= S.pauseActivityMin && after >= S.pauseActivityMin) pSum += clamp01(silent / meas / S.pauseSilentFraction);
    else noAct++;
  }
  out.pauses = { score: pDen > 0 ? pSum / pDen : null, n: pDen, noActivity: noAct };

  // ── القوة النسبية (محصورة بالإطارات التي الطبقة فيها قريبة من اللحن)
  let dSum = 0, dDen = 0, dMatched = 0;
  const rels = [];
  if (comfort != null) {
    const w = Math.max(1, Math.round(S.dynSmoothSec / hop) | 1);
    const smooth = (arr, valid) => {
      const o = new Float32Array(n).fill(NaN), h = w >> 1;
      for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let q = Math.max(0, i - h); q <= Math.min(n - 1, i + h); q++) if (valid(q)) { s += arr[q]; c++; } if (c) o[i] = s / c; }
      return o;
    };
    const ud = smooth(g.db, (q) => U.ok[q] === 1);
    const rd = smooth(ref.energyDb.subarray(i0, i1), (q) => R.pv[q] === 1);
    for (let i = 0; i < n; i++) {
      if (!R.pv[i]) continue;
      const j = i + lagFrames;
      if (j < 0 || j >= n || !g.meas[j]) continue;
      dDen++;
      if (U.ok[j] && Number.isFinite(ud[j]) && Number.isFinite(rd[i]) && Math.abs(U.cents[j] - Rc[i] - offset) <= S.dynGatePitchCents) {
        const rel = (ud[j] - comfort) - (rd[i] - refMed);
        rels.push(rel);
        dSum += tol(rel, S.dynFullDb, S.dynZeroDb);
        dMatched++;
      }
    }
  }
  const sr_ = rels.slice().sort((a, b) => a - b);
  out.dynamics = {
    score: comfort != null && dDen > 0 ? dSum / dDen : null, matchedFrames: dMatched,
    medianRelDb: sr_.length ? sr_[sr_.length >> 1] : null, calibrated: comfort != null,
  };

  // ── الإجمالي (متوسط موزون للأبعاد المتاحة)
  let ws = 0, wt = 0;
  for (const k of ['pitch', 'timing', 'pauses', 'dynamics']) {
    const v = out[k].score;
    if (v != null && Number.isFinite(v)) { ws += S.weights[k] * v; wt += S.weights[k]; }
  }
  out.overall = wt > 0 ? ws / wt : null;
  out.overallReason = out.overall == null ? 'no-dimension' : 'ok';
  out.errTrackCents = opts.detail ? errTrack : undefined;
  return out;
}

/**
 * ثقة التقييم (0..1) مع بيان العوامل. تُخفَّض أو يُعطَّل التقييم الرقمي إن لم يثبت استقلال الميكروفون عن المرجع.
 *  leak: {level: 0..1 | null (غير مقاس), detected: bool}
 */
export function computeConfidence({ headphones, leak, latencySource, calibrated, measurableFraction, processingOn, lagReliable, alignmentUnreliable }) {
  const factors = [];
  let c = 1;
  const mul = (v, label) => { if (v !== 1) { c *= v; factors.push({ label, factor: v }); } };
  let independence = 'verified';
  if (leak?.detected || (leak?.level != null && leak.level >= 0.5)) { independence = 'violated'; mul(0.2, 'الميكروفون يلتقط صوت المرجع (تسرّب)'); }
  else if (!headphones) { independence = 'unverified'; mul(0.6, 'وضع مكبّرات: قد يلتقط الميكروفون المرجع'); }
  else if (leak?.level == null) { independence = 'unverified'; mul(0.85, 'لم يُقَس التسرّب'); }
  if (latencySource !== 'measured-loopback') mul(0.9, 'التأخير مُقدَّر لا مقيس');
  if (!calibrated) mul(0.7, 'بلا معايرة');
  if (processingOn) mul(0.85, 'معالجة صوت المتصفح فعّالة (AGC/تقليل ضجيج/صدى)');
  if (measurableFraction < 0.8) mul(Math.max(0.3, measurableFraction), 'جزء من الوقت غير قابل للقياس');
  if (lagReliable === false) mul(0.85, 'إزاحة التوقيت غير موثوقة');
  if (alignmentUnreliable) mul(0.85, 'حدود الشطر ضعيفة الأدلة');
  return { value: clamp01(c), factors, independence, numericScoringAllowed: independence !== 'violated' };
}
