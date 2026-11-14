// جلسة التقييم: مقاطع تشغيل منفصلة (play/seek/restart-line) لكل منها إطاراتها ومقياس δ الخاص بها.
// يمنع خلط بيانات قديمة: كل مقطع جديد يبدأ نظيفًا؛ ومقارنة نافذة مرجعية تأخذ المقطع الأحدث فقط (أو مقاطع محددة).
import { DeltaTracker, alignTapToReference, refTimeForMic } from './sync.js';

export class Session {
  constructor() {
    this.segments = [];
    this.cur = null;
    this.nextId = 1;
  }

  /** يفتح مقطعًا جديدًا (ويغلق الحالي). settleSec: إطارات المقطع الأولى تُعلَّم «استقرار» ولا تُقاس. */
  newSegment(reason, { startCtx = null, settleSec = 0.12, guessDelta = null } = {}) {
    if (this.cur) this.cur.closed = true;
    const seg = {
      id: this.nextId++, reason, startCtx, settleSec, guessDelta, closed: false,
      mic: { t: [], f0: [], per: [], db: [], voiced: [], meas: [] },
      tap: { t: [], db: [] }, tracker: new DeltaTracker(), alignLog: [],
    };
    this.segments.push(seg);
    this.cur = seg;
    return seg;
  }

  closeSegment() { if (this.cur) { this.cur.closed = true; this.cur = null; } }

  addMic(f) {
    const s = this.cur;
    if (!s) return false;
    if (s.startCtx == null) s.startCtx = f.tCtx;
    const settling = f.tCtx < s.startCtx + s.settleSec;
    const m = s.mic;
    m.t.push(f.tCtx); m.f0.push(f.f0); m.per.push(f.periodicity); m.db.push(f.energyDb);
    m.voiced.push(f.voiced ? 1 : 0); m.meas.push(settling || f.unmeasurable ? 0 : 1);
    return true;
  }

  addTap(f) {
    const s = this.cur;
    if (!s) return false;
    s.tap.t.push(f.tCtx); s.tap.db.push(f.energyDb);
    return true;
  }

  /** يحاول قياس δ من آخر windowSec من التقاط المرجع. يعيد نتيجة المحاذاة أو null. */
  tryAlign(refData, { windowSec = 4, minSec = 2.5, searchSec = 1.5 } = {}) {
    const s = this.cur;
    if (!s || s.guessDelta == null || s.tap.t.length < 10) return null;
    const n = s.tap.t.length;
    const tEnd = s.tap.t[n - 1];
    if (tEnd - s.tap.t[0] < minSec) return null;
    let a = n - 1;
    while (a > 0 && tEnd - s.tap.t[a - 1] <= windowSec) a--;
    const guess = s.tracker.count ? s.tracker.at(tEnd) : s.guessDelta;
    const r = alignTapToReference(s.tap.t.slice(a), s.tap.db.slice(a), refData.energyDb, refData.hop,
      refData.timeOrigin, guess, { searchSec: s.tracker.count ? 0.3 : searchSec });
    s.alignLog.push({ tCtx: tEnd, ...r });
    if (r.ok) s.tracker.add(0.5 * (s.tap.t[a] + tEnd), r.delta, r.corr);
    return r;
  }

  /**
   * عينات المستخدم بزمن مرجعي لنافذة [tStart,tEnd) باستعمال المقطع الأحدث الذي يغطّيها (دون خلط).
   * latency: {inputSec, outputSec, manualSec}. يعيد {t,f0,periodicity,energyDb,voiced,measurable,segmentId,coverageSec}.
   */
  userTrack(latency, { tStart, tEnd, segmentIds = null }) {
    const cands = [...this.segments].reverse().filter((s) => !segmentIds || segmentIds.includes(s.id));
    for (const s of cands) {
      const tr = this._mapSegment(s, latency, tStart, tEnd);
      if (!tr) continue;
      // تغطية النافذة بالإطارات القابلة للقياس
      let cover = 0;
      for (let i = 0; i < tr.t.length; i++) if (tr.t[i] >= tStart && tr.t[i] < tEnd && tr.measurable[i]) cover++;
      if (cover * 0.01 >= 1.0) return { ...tr, segmentId: s.id, coverageSec: cover * 0.01 };
    }
    return { t: new Float64Array(0), f0: new Float32Array(0), periodicity: new Float32Array(0), energyDb: new Float32Array(0),
      voiced: new Uint8Array(0), measurable: new Uint8Array(0), segmentId: null, coverageSec: 0 };
  }

  /**
   * يحوّل إطارات مقطع إلى زمن مرجعي. يقتصر على الإطارات التي يقع زمنها المرجعي ضمن [tStart−pad, tEnd+pad]
   * (بحث ثنائي على زمن السياق المرتّب) فلا يُعاد تخصيص المقطع كاملًا مع كل استدعاء حي.
   */
  _mapSegment(s, latency, tStart = -Infinity, tEnd = Infinity, pad = 1.0) {
    const m = s.mic;
    if (!m.t.length) return null;
    let lo = 0, hi = m.t.length;
    if (Number.isFinite(tStart) && Number.isFinite(tEnd)) {
      const d0 = s.tracker.at(m.t[0]), d1 = s.tracker.at(m.t[m.t.length - 1]);
      if (d0 == null || d1 == null) return null;
      const lat = latency.inputSec + latency.outputSec + latency.manualSec;
      // tRef = tCtx − δ − lat  ⇒  tCtx = tRef + δ + lat   (δ قد يتغير ببطء؛ نأخذ هامشًا بالحدّين)
      const cLo = tStart - pad + Math.min(d0, d1) + lat - 0.05, cHi = tEnd + pad + Math.max(d0, d1) + lat + 0.05;
      lo = lowerBound(m.t, cLo); hi = lowerBound(m.t, cHi);
      if (hi <= lo) return null;
    }
    const n = hi - lo;
    const t = new Float64Array(n), f0 = new Float32Array(n), per = new Float32Array(n), db = new Float32Array(n);
    const voiced = new Uint8Array(n), meas = new Uint8Array(n);
    let any = false;
    for (let k = 0; k < n; k++) {
      const i = lo + k;
      const d = s.tracker.at(m.t[i]);
      if (d == null) { t[k] = NaN; continue; }  // لا δ مقيس: لا نخترع موضعًا مرجعيًا
      t[k] = refTimeForMic(m.t[i], d, latency);
      f0[k] = m.f0[i]; per[k] = m.per[i]; db[k] = m.db[i]; voiced[k] = m.voiced[i]; meas[k] = m.meas[i];
      any = true;
    }
    if (!any) return null;
    const keep = [];
    for (let k = 0; k < n; k++) if (Number.isFinite(t[k])) keep.push(k);
    const pick = (arr, Ctor) => { const o = new Ctor(keep.length); keep.forEach((k, j) => { o[j] = arr[k]; }); return o; };
    return { t: pick(t, Float64Array), f0: pick(f0, Float32Array), periodicity: pick(per, Float32Array),
      energyDb: pick(db, Float32Array), voiced: pick(voiced, Uint8Array), measurable: pick(meas, Uint8Array) };
  }
}

function lowerBound(arr, x) {
  let a = 0, b = arr.length;
  while (a < b) { const m = (a + b) >> 1; if (arr[m] < x) a = m + 1; else b = m; }
  return a;
}

/**
 * اقتراح إزاحة «وضع الراحة» (سنت) من معايرة قصيرة: أقرب نصف نغمة لفرق الوسيطين. تُثبَّت طوال الجلسة.
 * منطقة ميتة (|الفرق| < 150 سنت ⇒ 0): وسيط قراءة قصيرة (≈ 6 ث) لا يُعتمد عليه لإزاحات صغيرة، والإزاحة الخاطئة تُعاقب مغنّيًا مطابقًا للمرجع.
 * عتبة تجريبية غير معايَرة على متحدثين حقيقيين.
 */
export const COMFORT_DEAD_ZONE_CENTS = 150;
export function suggestComfortOffset(userMedianCents, refMedianCents) {
  if (!Number.isFinite(userMedianCents) || !Number.isFinite(refMedianCents)) return 0;
  const d = userMedianCents - refMedianCents;
  if (Math.abs(d) < COMFORT_DEAD_ZONE_CENTS) return 0;
  return Math.round(d / 100) * 100;
}
