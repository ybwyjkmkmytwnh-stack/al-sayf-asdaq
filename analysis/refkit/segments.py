"""كشف مناطق الكلام/الصمت والأحداث الصوتية (وقفات، مدود، بدايات) من سمات الإطار.

كل الأحداث «قياسات صوتية» لا أكثر؛ لا تُنسب لها دلالة لفظية.
"""
from __future__ import annotations

import numpy as np

from .features import runs, rolling_median


def active_span(db: np.ndarray, hop_s: float, on_db: float = -35.0, min_on_s: float = 0.15):
    """بداية ونهاية الأداء: أول/آخر زمن تتجاوز فيه الطاقة on_db لمدة min_on_s على الأقل."""
    n_min = int(round(min_on_s / hop_s))
    rs = [(i, j) for i, j in runs(db > on_db) if (j - i) >= n_min]
    if not rs:
        return None
    return rs[0][0] * hop_s, rs[-1][1] * hop_s


def local_baseline_db(db: np.ndarray, hop_s: float, win_s: float = 3.0):
    size = int(round(win_s / hop_s)) | 1
    return rolling_median(np.maximum(db, -60.0), size)


def detect_dips(db: np.ndarray, hop_s: float, t0: float, t1: float,
                rel_depth_db: float = 15.0, min_dur_s: float = 0.05):
    """انخفاضات الطاقة النسبية إلى خط أساس محلي. تُعاد كقوائم قواميس."""
    base = local_baseline_db(db, hop_s)
    lo, hi = int(round(t0 / hop_s)), int(round(t1 / hop_s))
    mask = np.zeros_like(db, dtype=bool)
    mask[lo:hi] = db[lo:hi] < (base[lo:hi] - rel_depth_db)
    out = []
    for i, j in runs(mask):
        dur = (j - i) * hop_s
        if dur < min_dur_s:
            continue
        seg = db[i:j]
        depth = float(np.median(base[i:j]) - seg.min())
        out.append({
            "startSec": i * hop_s, "endSec": j * hop_s, "centerSec": (i + j) / 2 * hop_s,
            "durationSec": dur, "minDb": float(seg.min()), "depthDb": depth,
            "strength": float(min(1.0, dur / 0.25) * min(1.0, depth / 20.0)),
        })
    return out


def detect_sustains(f0: np.ndarray, voiced: np.ndarray, hop_s: float, min_dur_s: float = 0.40,
                    tol_cents: float = 70.0):
    """مدود: مقاطع مجهورة تبقى فيها الطبقة ضمن ±tol_cents حول وسيط نافذتها الأولى.
    (قياس صوتي لثبات الطبقة؛ لا يُثبت أن القارئ مدّ حرف علة بعينه.)"""
    m = voiced & np.isfinite(f0)
    cents = np.full(len(f0), np.nan)
    cents[m] = 1200.0 * np.log2(f0[m] / 100.0)
    out = []
    n = len(f0)
    i = 0
    while i < n:
        if not m[i]:
            i += 1
            continue
        j = i
        while j < n and m[j] and abs(cents[j] - np.median(cents[i:min(j + 1, i + 30)])) < tol_cents:
            j += 1
        if (j - i) * hop_s >= min_dur_s:
            seg = cents[i:j]
            out.append({"startSec": i * hop_s, "endSec": j * hop_s,
                        "durationSec": (j - i) * hop_s,
                        "medianHz": float(100.0 * 2 ** (np.median(seg) / 1200.0))})
            i = j
        else:
            i += 1
    return out


def detect_onsets(db: np.ndarray, voiced: np.ndarray, hop_s: float, t0: float, t1: float,
                  rise_db: float = 8.0, within_s: float = 0.08):
    """بدايات: ارتفاع طاقة ≥ rise_db خلال within_s يلي انخفاضًا؛ تُسجَّل عند منتصف الصعود."""
    k = max(1, int(round(within_s / hop_s)))
    lo, hi = int(round(t0 / hop_s)), min(len(db) - k - 1, int(round(t1 / hop_s)))
    out = []
    i = max(lo, 1)
    while i < hi:
        rise = db[i + k] - db[i]
        if rise >= rise_db and db[i] < db[i - 1] + 1.0:
            # امتد حتى نهاية الصعود
            j = i
            while j < hi and db[j + 1] >= db[j] - 0.3:
                j += 1
            out.append({"timeSec": (i + j) / 2 * hop_s, "riseDb": float(db[j] - db[i]),
                        "voiced": bool(voiced[min(j, len(voiced) - 1)])})
            i = j + 1
        else:
            i += 1
    return out
