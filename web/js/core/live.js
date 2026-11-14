// مؤشرات التوجيه الحيّ (أثناء الأداء): انحراف طبقة/قوة/توقيت على نافذة قصيرة حديثة، وتلميحات مستقرة.
//
// هذه المؤشرات «إرشاد لحظي» وليست الدرجة النهائية: تُحسب من نفس الإطارات المنسوبة زمنيًا (الجلسة) ونفس عتبات التقييم،
// لكن على نافذة قصيرة (≈1.6 ث للطبقة/القوة و3 ث للتوقيت)، فتكون أقل ثباتًا. الغياب (صمت المستخدم) ≠ خطأ طبقة ≠ فشل قياس.
//
// إشارة الانحراف:
//   pitch.devCents  > 0 : صوت المستخدم أعلى من المرجع (بعد إزاحة الراحة الثابتة)   → «اخفض الطبقة»
//   level.devDb     > 0 : المستخدم أقوى نسبةً لمستوى معايرته مقارنةً بقوة المرجع النسبية → «خفّض قوة الصوت»
//   timing.lagSec   > 0 : المستخدم متأخر عن المرجع                                  → «بدأت متأخرًا»
import { DEFAULT_SCORING, medianSmooth, pitchQualityArray, resampleUserToGrid, envelopeLag } from './score.js';

export const LIVE_THRESHOLDS = Object.freeze({
  // أخضر ≤ ok، أصفر ≤ warn، أحمر > warn. عتبة التلميح = warn (أي عند الدخول في الأحمر).
  pitchCents: { ok: 50, warn: 100 },
  timingSec: { ok: 0.10, warn: 0.20 },
  levelDb: { ok: 4, warn: 6 },
  pitchSpanSec: 1.6, timingSpanSec: 3.0,
  minMatchedFrames: 25, minRefVoicedFrames: 40,
  absentFraction: 0.85,
});

export const HINT_TEXT = Object.freeze({
  'pitch-low': 'ارفع الطبقة', 'pitch-high': 'اخفض الطبقة',
  'level-low': 'زد قوة الصوت', 'level-high': 'خفّض قوة الصوت',
  'timing-late': 'بدأت متأخرًا', 'timing-early': 'بدأت مبكرًا',
  'sustain-short': 'أطل المد',
});

const stateOf = (absV, t) => (absV <= t.ok ? 'ok' : absV <= t.warn ? 'warn' : 'bad');
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]); };

/**
 * user: ناتج Session.userTrack (زمن مرجعي). tNow: الموضع المرجعي «الحالي» عند أذن المستخدم.
 * يعيد {pitch, level, timing, sustain, absent, reason}.
 */
export function computeLive(ref, user, { tNow, offsetCents = 0, calibration = {}, scoring = {} } = {}) {
  const T = LIVE_THRESHOLDS;
  const S = { ...DEFAULT_SCORING, ...scoring };
  const hop = ref.hop;
  const none = { state: 'none' };
  const res = { tNow, pitch: { ...none, devCents: null }, level: { ...none, devDb: null }, timing: { ...none, lagSec: null }, sustain: { short: false }, absent: false, reason: null };
  const i1 = Math.min(ref.n, ref.idx(tNow));
  if (!(i1 > 60) || !user?.t?.length) { res.reason = 'no-data'; return res; }

  // ── نافذة الطبقة/القوة (قصيرة)
  const nP = Math.round(T.pitchSpanSec / hop);
  const p0 = Math.max(0, i1 - nP), n = i1 - p0;
  const g = resampleUserToGrid(ref, user, p0, i1);
  const q = pitchQualityArray(g.f0, g.voiced, g.periodicity);
  const uC = new Float32Array(n).fill(NaN);
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (g.meas[i] && g.voiced[i] && Number.isFinite(g.f0[i]) && q[i] >= S.minPitchQuality && g.periodicity[i] >= S.userVoicedPeriodicity) {
      uC[i] = 1200 * Math.log2(g.f0[i] / 100); ok[i] = 1;
    }
  }
  const uS = medianSmooth(uC, S.smoothFrames);
  const rS = medianSmooth(ref.cents.subarray(p0, i1), S.smoothFrames);
  const errs = [], userDb = [], refDb = [];
  let refVoiced = 0, measured = 0;
  for (let i = 0; i < n; i++) {
    if (!ref.usablePitch(p0 + i) || !Number.isFinite(rS[i])) continue;
    refVoiced++;
    if (!g.meas[i]) continue;
    measured++;
    if (ok[i] && Number.isFinite(uS[i])) {
      const e = uS[i] - rS[i] - offsetCents;
      errs.push(e);
      if (Math.abs(e) <= S.dynGatePitchCents) { userDb.push(g.db[i]); refDb.push(ref.energyDb[p0 + i]); }
    }
  }
  if (measured < T.minRefVoicedFrames) {
    res.reason = refVoiced < T.minRefVoicedFrames ? 'reference-not-voiced' : 'unmeasurable';
  } else if (errs.length < T.minMatchedFrames) {
    // المرجع مجهور ومقيس لكن المستخدم لا يطابق: غياب إن كان شبه صامت، وإلا «لا قياس موثوق للطبقة»
    if ((measured - errs.length) / measured >= T.absentFraction) { res.absent = true; res.reason = 'user-absent'; }
    else res.reason = 'few-matched';
  } else {
    const dev = median(errs);
    res.pitch = { devCents: dev, matched: errs.length, state: stateOf(Math.abs(dev), T.pitchCents) };
    const comfort = Number.isFinite(calibration.comfortLevelDb) ? calibration.comfortLevelDb : null;
    if (comfort != null && userDb.length >= T.minMatchedFrames) {
      const refMed = ref.stats?.energyDbVoiced?.p50 ?? -9;
      const dev2 = (median(userDb) - comfort) - (median(refDb) - refMed);
      res.level = { devDb: dev2, state: stateOf(Math.abs(dev2), T.levelDb) };
    }
  }

  // ── التوقيت (نافذة أطول، غلاف الطاقة المجهورة)
  const nT = Math.round(T.timingSpanSec / hop);
  const t0 = Math.max(0, i1 - nT), m = i1 - t0;
  if (m > 200) {
    const gt = resampleUserToGrid(ref, user, t0, i1);
    const qt = pitchQualityArray(gt.f0, gt.voiced, gt.periodicity);
    const U = { n: m, ok: new Uint8Array(m), meas: gt.meas };
    const R = { n: m, pv: new Uint8Array(m) };
    let rv = 0, uv = 0;
    for (let i = 0; i < m; i++) {
      if (gt.meas[i] && gt.voiced[i] && qt[i] >= S.minPitchQuality && gt.periodicity[i] >= S.userVoicedPeriodicity) { U.ok[i] = 1; uv++; }
      if (ref.usablePitch(t0 + i)) { R.pv[i] = 1; rv++; }
    }
    if (rv > 0.4 * m && uv > 0.3 * m) {
      const env = envelopeLag(R, ref.energyDb.subarray(t0, i1), U, gt, Math.round(0.6 / hop));
      if (env.reliable) {
        const lag = env.lagFrames * hop;
        res.timing = { lagSec: lag, corr: env.corr, state: stateOf(Math.abs(lag), T.timingSec) };
      }
    }
  }

  // ── المدّ: انتهى مدّ مرجعي للتو (≤ 0.8 ث) وأمسك المستخدم بدايته لكنه تركه قبل نهايته
  for (let k = ref.sustains.length - 1; k >= 0; k--) {
    const s = ref.sustains[k];
    if (s.endSec > tNow) continue;
    if (tNow - s.endSec > 0.8) break;
    if (s.endSec - s.startSec < 0.6) continue;
    const a = ref.idx(s.startSec), b = ref.idx(s.endSec);
    const gs = resampleUserToGrid(ref, user, a, b);
    const qs = pitchQualityArray(gs.f0, gs.voiced, gs.periodicity);
    const len = b - a, mid = Math.round(len * 0.5), first = Math.round(len * 0.3);
    let f = 0, fm = 0, l = 0, lm = 0;
    for (let i = 0; i < len; i++) {
      if (!gs.meas[i]) continue;
      const holds = gs.voiced[i] && qs[i] >= S.minPitchQuality;
      if (i < first) { fm++; if (holds) f++; }
      if (i >= mid) { lm++; if (holds) l++; }
    }
    if (fm > first * 0.6 && lm > (len - mid) * 0.6 && f / fm >= 0.6 && l / lm < 0.4) res.sustain = { short: true, endSec: s.endSec, startedRatio: f / fm, endRatio: l / lm };
    break;
  }
  return res;
}

/** يحوّل نتيجة computeLive إلى معرّف تلميح مرشّح (أو null) بحسب الأولوية: مدّ ← توقيت ← طبقة ← قوة. */
export function candidateHint(live) {
  const T = LIVE_THRESHOLDS;
  if (live.sustain?.short) return 'sustain-short';
  if (live.timing?.state === 'bad') return live.timing.lagSec > 0 ? 'timing-late' : 'timing-early';
  if (live.pitch?.state === 'bad' && Math.abs(live.pitch.devCents) > T.pitchCents.warn) return live.pitch.devCents < 0 ? 'pitch-low' : 'pitch-high';
  if (live.level?.state === 'bad') return live.level.devDb < 0 ? 'level-low' : 'level-high';
  return null;
}

/**
 * تلميحات مستقرة: لا يظهر تلميح إلا بعد confirmN تقييمات متتالية متطابقة، ويبقى minShowMs على الأقل،
 * ولا يزول إلا بعد clearN تقييمات بلا مرشّح. تلميح واحد في كل لحظة.
 */
export class HintController {
  constructor({ confirmN = 3, clearN = 3, minShowMs = 1500 } = {}) {
    Object.assign(this, { confirmN, clearN, minShowMs });
    this.reset();
  }
  reset() { this.cur = null; this.shownAt = 0; this.cand = null; this.candN = 0; this.clearCount = 0; }
  update(live, nowMs) {
    const c = candidateHint(live);
    if (c) {
      this.clearCount = 0;
      if (c === this.cand) this.candN++; else { this.cand = c; this.candN = 1; }
      if (c !== this.cur && this.candN >= this.confirmN && (this.cur == null || nowMs - this.shownAt >= this.minShowMs)) {
        this.cur = c; this.shownAt = nowMs;
      }
    } else {
      this.cand = null; this.candN = 0; this.clearCount++;
      if (this.cur && this.clearCount >= this.clearN && nowMs - this.shownAt >= this.minShowMs) this.cur = null;
    }
    return this.cur ? { id: this.cur, text: HINT_TEXT[this.cur] } : null;
  }
}
