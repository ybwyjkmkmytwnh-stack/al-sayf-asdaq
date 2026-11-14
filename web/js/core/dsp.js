// أدوات DSP عامة (تعمل في المتصفح/Worker/Node بلا اعتماديات).
// كل الدوال هنا نقية ومغطاة باختبارات node:test.

export const EPS_POWER = 1e-12; // يطابق features.py (floor = -120 dB)

/** طاقة نافذة مستطيلة [start, start+w) بالديسيبل (re 1.0 RMS). تُعامل العينات خارج المدى كأصفار. */
export function windowEnergyDb(x, start, w) {
  let s = 0;
  const a = Math.max(0, start), b = Math.min(x.length, start + w);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return 10 * Math.log10(Math.max(s / w, EPS_POWER));
}

export function median(arr) {
  const n = arr.length;
  if (!n) return NaN;
  const a = Float64Array.from(arr).sort();
  return n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

export function percentile(arr, p) {
  const n = arr.length;
  if (!n) return NaN;
  const a = Float64Array.from(arr).sort();
  const k = (p / 100) * (n - 1);
  const lo = Math.floor(k), hi = Math.ceil(k);
  return a[lo] + (a[hi] - a[lo]) * (k - lo);
}

export const centsBetween = (f, fref) => 1200 * Math.log2(f / fref);
export const hzToCents100 = (f) => 1200 * Math.log2(f / 100);

/** FIR منخفض التمرير بنافذة Hann-sinc: يعيد المعاملات (طول فردي). */
export function designLowpass(cutoffNorm, taps) {
  // cutoffNorm: التردد القاطع نسبةً إلى معدل أخذ العينات (0..0.5)
  const h = new Float64Array(taps);
  const m = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - m;
    const sinc = k === 0 ? 2 * cutoffNorm : Math.sin(2 * Math.PI * cutoffNorm * k) / (Math.PI * k);
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * win;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum; // كسب DC = 1
  return h;
}

/**
 * مُقلِّل معدل عيّنات متدفق بعامل صحيح D مع مرشّح FIR سببي.
 * العيّنة المخرَجة رقم m (منذ reset) تقابل فهرس الدخل العام m*D ناقصًا تأخير المجموعة `delay`.
 */
export class Decimator {
  constructor(D, taps = 63, cutoffFrac = 0.45) {
    this.D = D;
    this.taps = taps;
    this.delay = (taps - 1) / 2; // تأخير المجموعة بعينات الدخل
    this.h = designLowpass(cutoffFrac / D, taps);
    this.hist = new Float32Array(taps - 1);
    this.inCount = 0; // عدد عينات الدخل منذ reset
  }
  reset() { this.hist.fill(0); this.inCount = 0; }
  /** يعيد {out, firstOutIndex}: الفهرس (منذ reset) للعيّنة المخرَجة الأولى في هذه الدفعة. */
  process(x) {
    const { D, taps, h, hist } = this;
    const n = x.length, s = this.inCount;
    const ext = new Float32Array(taps - 1 + n);
    ext.set(hist, 0);
    ext.set(x, taps - 1);
    const i0 = (D - (s % D)) % D;
    const outLen = i0 < n ? Math.floor((n - 1 - i0) / D) + 1 : 0;
    const out = new Float32Array(outLen);
    for (let o = 0, i = i0; i < n; i += D, o++) {
      let acc = 0;
      const base = i + taps - 1;
      for (let k = 0; k < taps; k++) acc += h[k] * ext[base - k];
      out[o] = acc;
    }
    hist.set(ext.subarray(ext.length - (taps - 1)));
    this.inCount += n;
    return { out, firstOutIndex: (s + i0) / D };
  }
}

// ───────── FFT (أساس 2، في المكان) — للارتباط المتقاطع المستعمل في كشف التسرّب ─────────
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const nextPow2 = (n) => 1 << Math.ceil(Math.log2(Math.max(2, n)));

/**
 * ارتباط متقاطع معيَّر بين a (مرجع) و b (ميكروفون) للتأخرات 0..maxLag عينة:
 * r[l] = Σ a[i] b[i+l] / sqrt(Σa² Σb²)  (b متأخر عن a بمقدار l).
 * يعيد {bestLag, bestCorr, corr:Float32Array}. لا يطرح المتوسط (إشارات صوت متمركزة عند الصفر).
 */
export function normalizedXcorr(a, b, maxLag) {
  const n = Math.min(a.length, b.length);
  const N = nextPow2(n + maxLag + 1);
  const ar = new Float64Array(N), ai = new Float64Array(N);
  const br = new Float64Array(N), bi = new Float64Array(N);
  let ea = 0, eb = 0;
  for (let i = 0; i < n; i++) { ar[i] = a[i]; br[i] = b[i]; ea += a[i] * a[i]; eb += b[i] * b[i]; }
  fft(ar, ai); fft(br, bi);
  // r = IFFT( conj(A) * B )
  for (let i = 0; i < N; i++) {
    const xr = ar[i] * br[i] + ai[i] * bi[i];
    const xi = ar[i] * bi[i] - ai[i] * br[i];
    ar[i] = xr; ai[i] = xi;
  }
  fft(ar, ai, true);
  const norm = Math.sqrt(ea * eb) || 1;
  const corr = new Float32Array(maxLag + 1);
  let bestLag = 0, bestCorr = -Infinity;
  for (let l = 0; l <= maxLag; l++) {
    const v = ar[l] / norm;
    corr[l] = v;
    if (v > bestCorr) { bestCorr = v; bestLag = l; }
  }
  return { bestLag, bestCorr, corr };
}
