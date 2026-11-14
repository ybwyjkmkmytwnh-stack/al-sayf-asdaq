"""سمات الإطار المشتركة بين التحليل المرجعي (Python) والمقدّر الحي (JS).

التعريفات هنا هي «المرجع» وتُطابَق حرفيًا في web/js/core/dsp.js:
  • طاقة الإطار: جذر متوسط المربعات في نافذة مستطيلة طولها win_s مركزها زمن الإطار
    (centered)، بالديسيبل نسبةً إلى القيمة 1.0 (full scale)، وأرضيتها −120 dB.
  • زمن الإطار i = i * hop_s (مركز النافذة).
"""
from __future__ import annotations

import numpy as np
from scipy.ndimage import median_filter


def frame_energy_db(x: np.ndarray, sr: int, hop_s: float, win_s: float, n_frames: int) -> np.ndarray:
    hop = int(round(hop_s * sr))
    w = int(round(win_s * sr))
    half = w // 2
    xp = np.concatenate([np.zeros(half), np.asarray(x, dtype=np.float64), np.zeros(w)])
    c = np.concatenate([[0.0], np.cumsum(xp * xp)])
    centers = np.arange(n_frames) * hop + half
    a = centers - half
    b = a + w
    ms = (c[np.minimum(b, len(c) - 1)] - c[np.minimum(a, len(c) - 1)]) / w
    return 10.0 * np.log10(np.maximum(ms, 1e-12))


def rolling_median(y: np.ndarray, size: int) -> np.ndarray:
    return median_filter(y, size=size, mode="nearest")


def runs(mask: np.ndarray):
    """يعيد قائمة (i, j) لمقاطع True المتصلة، j حصرية."""
    m = np.asarray(mask, dtype=bool)
    if m.size == 0:
        return []
    d = np.diff(np.concatenate([[0], m.astype(np.int8), [0]]))
    s = np.nonzero(d == 1)[0]
    e = np.nonzero(d == -1)[0]
    return list(zip(s.tolist(), e.tolist()))
