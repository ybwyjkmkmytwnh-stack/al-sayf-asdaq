"""تنفيذ pYIN بـ numpy (بعد Mauch & Dixon, 2014) — مكتوب هنا من الصفر.

المراحل (كما في الورقة):
  1) دالة الفرق التراكمية المطبَّعة (CMNDF) لكل إطار عبر FFT.
  2) لكل عتبة من 100 عتبة تُنتج ترشيحات هي «أول قيعان تحت العتبة»، وتُوزَّع
     كتلة الاحتمال بحسب منحنى Beta على العتبات وتوزيع Boltzmann على ترتيب
     القيعان (الأقصر تأخرًا أرجح). النتيجة: احتمالات ملاحَظة لكل قاع + احتمال
     جهر الإطار = مجموع كتل الترشيحات.
  3) HMM ذو طبقتين (مجهور / غير مجهور) × خانات طبقة بدقة 10 سنت، انتقالات
     مثلثية محدودة بسرعة قصوى للتغير، وتفكيك Viterbi بحافة (band) كي يبقى
     الحساب قابلًا للتنفيذ على 65 ألف إطار.

ملاحظات صدق مهمة:
  • «احتمال الجهر» ليس ضمانًا لصحة F0؛ لذلك نُخرج بجانبه `periodicity`
    (= 1 − CMNDF عند فترة الطبقة المختارة) وتُشتق منهما جودة الطبقة في pipeline.
  • الإطار يُؤرَّخ بمركز المخزن المؤقت (L = W + tau_max). نفس الاصطلاح
    مستخدم في المقدّر الحي بالمتصفح، فلا انحياز نسبي بينهما.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.stats import beta as _beta


@dataclass(frozen=True)
class PyinParams:
    sr: int = 16000
    hop_s: float = 0.010
    window_s: float = 0.040          # نافذة تكامل YIN (W)
    fmin: float = 65.0
    fmax: float = 800.0
    n_thresholds: int = 100
    beta_a: float = 2.0
    beta_b: float = 18.0
    boltzmann: float = 2.0
    no_trough_prob: float = 0.01
    switch_prob: float = 0.01
    max_transition_rate_oct_s: float = 35.92
    resolution_cents: float = 10.0
    silence_db: float = -70.0        # إطار أخفض من هذا لا يُرشَّح له جهر
    chunk_frames: int = 2048

    def to_dict(self):
        return asdict(self)


@dataclass
class PyinResult:
    times: np.ndarray            # (T,) مراكز الإطارات بالثواني
    f0: np.ndarray               # (T,) هرتز، NaN حيث لا جهر
    voiced: np.ndarray           # (T,) bool — قرار HMM
    voiced_prob: np.ndarray      # (T,) احتمال الجهر الملاحَظ (قبل HMM)
    periodicity: np.ndarray      # (T,) 1 - CMNDF عند فترة F0 المختارة (NaN إن لا جهر)
    frame_rms_db: np.ndarray     # (T,) طاقة نافذة التكامل بالديسيبل
    params: PyinParams


def _geometry(p: PyinParams):
    tau_max = int(np.ceil(p.sr / p.fmin))
    tau_min = max(2, int(np.floor(p.sr / p.fmax)))
    W = int(round(p.window_s * p.sr))
    L = W + tau_max + 1
    return W, tau_min, tau_max, L


def cmndf_frames(xp: np.ndarray, starts: np.ndarray, W: int, tau_max: int):
    """يعيد (cmndf[nf, tau_max+1], e1[nf]) لإطارات تبدأ عند starts في xp المبطَّن."""
    L = W + tau_max + 1
    nf = len(starts)
    idx = starts[:, None] + np.arange(L)[None, :]
    seg = xp[idx]
    a = seg[:, :W]
    n_fft = 1 << int(np.ceil(np.log2(L)))
    A = np.fft.rfft(a, n_fft, axis=1)
    B = np.fft.rfft(seg, n_fft, axis=1)
    r = np.fft.irfft(np.conj(A) * B, n_fft, axis=1)[:, : tau_max + 1]
    e1 = (a * a).sum(axis=1)
    cs = np.concatenate([np.zeros((nf, 1)), np.cumsum(seg * seg, axis=1)], axis=1)
    e2 = cs[:, W: W + tau_max + 1] - cs[:, : tau_max + 1]
    d = np.maximum(e1[:, None] + e2 - 2.0 * r, 0.0)
    cum = np.cumsum(d[:, 1:], axis=1)
    tau = np.arange(1, tau_max + 1)[None, :]
    out = np.ones((nf, tau_max + 1))
    out[:, 1:] = d[:, 1:] * tau / (cum + 1e-12)
    return out, e1


def _parabolic(y: np.ndarray, i: int):
    """استيفاء قطع مكافئ حول القاع i؛ يعيد (موضع كسري، ارتفاع)."""
    if i <= 0 or i >= len(y) - 1:
        return float(i), float(y[i])
    y0, y1, y2 = y[i - 1], y[i], y[i + 1]
    den = y0 - 2.0 * y1 + y2
    if abs(den) < 1e-12:
        return float(i), float(y1)
    shift = 0.5 * (y0 - y2) / den
    shift = max(-1.0, min(1.0, shift))
    return i + shift, float(y1 - 0.25 * (y0 - y2) * shift)


def _boltzmann_pmf(pos: np.ndarray, lam: float, n: np.ndarray):
    with np.errstate(divide="ignore", invalid="ignore"):
        v = (1.0 - np.exp(-lam)) * np.exp(-lam * pos) / (1.0 - np.exp(-lam * n))
    return np.where(np.isfinite(v), v, 0.0)


def candidates_for_frame(y: np.ndarray, p: PyinParams, tau_min: int, tau_max: int,
                         beta_probs: np.ndarray, thr_hi: np.ndarray):
    """يعيد قائمة (f0_hz, probability, cmndf_height) للترشيحات."""
    seg = y[tau_min - 1: tau_max + 2]
    mid = seg[1:-1]
    is_t = (mid < seg[:-2]) & (mid <= seg[2:])
    # حافة البداية: كما في librosa تُعدّ قاعًا إن كانت أخفض من جارتها
    if len(mid) > 1 and mid[0] < mid[1] and not is_t[0]:
        is_t[0] = True
    tr = np.nonzero(is_t)[0] + tau_min
    if tr.size == 0:
        return [], 0.0
    heights = y[tr]
    below = np.less.outer(heights, thr_hi)                      # (nt, K)
    pos = np.cumsum(below, axis=0) - 1
    ntr = below.sum(axis=0)
    prior = _boltzmann_pmf(pos, p.boltzmann, ntr[None, :])
    prior = np.where(below, prior, 0.0)
    probs = prior @ beta_probs
    gmin = int(np.argmin(heights))
    n_below_min = int((~below[gmin]).sum())
    probs[gmin] += p.no_trough_prob * float(beta_probs[:n_below_min].sum())
    out = []
    for t, pr in zip(tr, probs):
        if pr <= 0:
            continue
        tau_f, h = _parabolic(y, int(t))
        if tau_f <= 0:
            continue
        out.append((p.sr / tau_f, float(pr), float(max(0.0, h))))
    return out, float(np.clip(probs.sum(), 0.0, 1.0))


def _band_max(prev: np.ndarray, c: np.ndarray, B: int):
    padded = np.concatenate([np.full(B, -np.inf), prev, np.full(B, -np.inf)])
    win = sliding_window_view(padded, 2 * B + 1)
    vals = win + c[None, :]
    m = vals.argmax(axis=1)
    best = vals[np.arange(prev.size), m]
    return best, (m - B).astype(np.int8)


def viterbi_two_layer(obs_v: np.ndarray, unv_logp: np.ndarray, B: int, switch_prob: float):
    """obs_v: (T, n_bins) احتمالات الحالات المجهورة (float32 يكفي).
    unv_logp: (T,) لوغاريتم احتمال كل خانة غير مجهورة (ثابت عبر الخانات داخل الإطار).
    يعيد (layer[T], bin[T]) حيث layer 0=مجهور، 1=غير مجهور."""
    T, nb = obs_v.shape
    k = np.arange(-B, B + 1)
    w = (B + 1 - np.abs(k)) / (B + 1.0)
    c = np.log(w / w.sum())
    ls, lns = np.log(switch_prob), np.log(1.0 - switch_prob)
    tiny = 1e-30
    pv = np.log(obs_v[0].astype(np.float64) + tiny) - np.log(2 * nb)
    pu = np.full(nb, unv_logp[0] - np.log(2 * nb))
    back_off = np.zeros((T, 2, nb), dtype=np.int8)
    back_src_unv = np.zeros((T, 2, nb), dtype=np.bool_)
    for t in range(1, T):
        av, ov = _band_max(pv, c, B)
        au, ou = _band_max(pu, c, B)
        lv = np.log(obs_v[t].astype(np.float64) + tiny)
        # إلى «مجهور»: بقاء من مجهور أو تبديل من غير مجهور
        stay_v, sw_v = av + lns, au + ls
        f_v = sw_v > stay_v
        nv = np.where(f_v, sw_v, stay_v) + lv
        back_off[t, 0] = np.where(f_v, ou, ov)
        back_src_unv[t, 0] = f_v
        # إلى «غير مجهور»: بقاء أو تبديل من مجهور
        stay_u, sw_u = au + lns, av + ls
        f_u = sw_u > stay_u
        nu = np.where(f_u, sw_u, stay_u) + unv_logp[t]
        back_off[t, 1] = np.where(f_u, ov, ou)
        back_src_unv[t, 1] = ~f_u
        pv, pu = nv, nu
    last = np.concatenate([pv, pu])
    s = int(np.argmax(last))
    layer = np.zeros(T, dtype=np.int8)
    binx = np.zeros(T, dtype=np.int32)
    l, j = (0, s) if s < nb else (1, s - nb)
    for t in range(T - 1, 0, -1):
        layer[t], binx[t] = l, j
        off = int(back_off[t, l, j])
        src_unv = bool(back_src_unv[t, l, j])
        j = min(max(j + off, 0), nb - 1)
        l = 1 if src_unv else 0
    layer[0], binx[0] = l, j
    return layer, binx


def analyze(x: np.ndarray, p: PyinParams = PyinParams()) -> PyinResult:
    x = np.asarray(x, dtype=np.float64)
    W, tau_min, tau_max, L = _geometry(p)
    hop = int(round(p.hop_s * p.sr))
    n_frames = int(len(x) // hop) + 1
    pad_l = L // 2 + 1
    pad_r = L + hop + 2
    xp = np.concatenate([np.zeros(pad_l), x, np.zeros(pad_r)])
    centers = np.arange(n_frames) * hop
    starts = centers - L // 2 + pad_l
    thresholds = np.linspace(0.0, 1.0, p.n_thresholds + 1)
    beta_probs = np.diff(_beta.cdf(thresholds, p.beta_a, p.beta_b))
    thr_hi = thresholds[1:]
    n_bins = int(np.ceil(1200.0 * np.log2(p.fmax / p.fmin) / p.resolution_cents)) + 1
    bin_freq = p.fmin * 2.0 ** (np.arange(n_bins) * p.resolution_cents / 1200.0)
    obs_v = np.zeros((n_frames, n_bins), dtype=np.float32)
    voiced_prob = np.zeros(n_frames)
    frame_db = np.full(n_frames, -120.0)
    cand_store = [None] * n_frames

    for c0 in range(0, n_frames, p.chunk_frames):
        c1 = min(n_frames, c0 + p.chunk_frames)
        cm, e1 = cmndf_frames(xp, starts[c0:c1], W, tau_max)
        db = 10.0 * np.log10(e1 / W + 1e-12)
        frame_db[c0:c1] = db
        for k in range(c1 - c0):
            t = c0 + k
            if db[k] < p.silence_db:
                continue
            cands, vp = candidates_for_frame(cm[k], p, tau_min, tau_max, beta_probs, thr_hi)
            voiced_prob[t] = vp
            cand_store[t] = cands
            for f, pr, _h in cands:
                if f < p.fmin or f > p.fmax:
                    continue
                b = int(round(1200.0 * np.log2(f / p.fmin) / p.resolution_cents))
                if 0 <= b < n_bins:
                    obs_v[t, b] += pr

    unv_logp = np.log((1.0 - voiced_prob + 1e-30) / n_bins)
    B = max(1, int(round(p.max_transition_rate_oct_s * p.hop_s * 1200.0 / p.resolution_cents)))
    layer, bins = viterbi_two_layer(obs_v, unv_logp, B, p.switch_prob)

    f0 = np.full(n_frames, np.nan)
    periodicity = np.full(n_frames, np.nan)
    voiced = layer == 0
    for t in np.nonzero(voiced)[0]:
        cands = cand_store[t]
        fb = bin_freq[bins[t]]
        best = None
        if cands:
            for f, pr, h in cands:
                d = abs(1200.0 * np.log2(f / fb))
                if d <= 1.5 * p.resolution_cents and (best is None or d < best[0]):
                    best = (d, f, h)
        if best is None:
            voiced[t] = False          # لا ترشيح يدعم الخانة: لا نختلق قيمة
            continue
        f0[t] = best[1]
        periodicity[t] = float(np.clip(1.0 - best[2], 0.0, 1.0))
    return PyinResult(centers / p.sr, f0, voiced, voiced_prob, periodicity, frame_db, p)
