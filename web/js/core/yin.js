// مقدّر YIN سببي (كشف طبقة لحظي). ليس pYIN: لا HMM ولا احتمالات، قرار الإطار وحده.
// الهندسة (W, tauMin, tauMax, L) تطابق analysis/refkit/pyin.py حرفيًا كي لا يختلف اصطلاح زمن الإطار.

export function yinGeometry(sr, p = {}) {
  const windowSec = p.windowSec ?? 0.04;
  const fmin = p.fmin ?? 65;
  const fmax = p.fmax ?? 800;
  const tauMax = Math.ceil(sr / fmin);
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const W = Math.round(windowSec * sr);
  return { sr, W, tauMin, tauMax, L: W + tauMax + 1 };
}

export class YinEstimator {
  constructor(sr, params = {}) {
    this.g = yinGeometry(sr, params);
    this.threshold = params.threshold ?? 0.2;   // عتبة YIN المطلقة
    this.weakLimit = params.weakLimit ?? 0.45;  // أدنى قاع مقبول إن لم يوجد قاع تحت العتبة
    this.cm = new Float64Array(this.g.tauMax + 2);
  }

  /** seg: مصفوفة عينات، تبدأ الإطار عند off وطولها ≥ L. يعيد {f0 (NaN إن لا طبقة), periodicity, tau}. */
  estimate(seg, off = 0) {
    const { W, tauMin, tauMax } = this.g;
    const cm = this.cm;
    let e1 = 0;
    for (let j = 0; j < W; j++) { const v = seg[off + j]; e1 += v * v; }
    if (e1 / W < 1e-10) return { f0: NaN, periodicity: 0, tau: 0 };
    let e2 = e1; // Σ_{j<W} seg[j+τ]² عند τ=0
    let cum = 0;
    cm[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      e2 += seg[off + tau - 1 + W] * seg[off + tau - 1 + W] - seg[off + tau - 1] * seg[off + tau - 1];
      let r = 0;
      const o = off + tau;
      for (let j = 0; j < W; j++) r += seg[off + j] * seg[o + j];
      let d = e1 + e2 - 2 * r;
      if (d < 0) d = 0;
      cum += d;
      cm[tau] = cum > 0 ? (d * tau) / cum : 1;
    }
    cm[tauMax + 1] = 1;
    // أول قاع تحت العتبة (بعد tauMin)، ثم النزول إلى قاعه المحلي
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cm[tau] < this.threshold) {
        while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      let gm = tauMin;
      for (let tau = tauMin; tau <= tauMax; tau++) if (cm[tau] < cm[gm]) gm = tau;
      if (cm[gm] < this.weakLimit) best = gm;
    }
    if (best < 0) return { f0: NaN, periodicity: Math.max(0, 1 - cm[tauMin]), tau: 0 };
    // استيفاء قطع مكافئ
    let tf = best, h = cm[best];
    if (best > 1 && best < tauMax) {
      const y0 = cm[best - 1], y1 = cm[best], y2 = cm[best + 1];
      const den = y0 - 2 * y1 + y2;
      if (Math.abs(den) > 1e-12) {
        let sh = (0.5 * (y0 - y2)) / den;
        sh = Math.max(-1, Math.min(1, sh));
        tf = best + sh;
        h = y1 - 0.25 * (y0 - y2) * sh;
      }
    }
    return { f0: this.g.sr / tf, periodicity: Math.min(1, Math.max(0, 1 - h)), tau: tf };
  }
}
