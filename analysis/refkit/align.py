"""محاذاة بنيوية صوتية: حدود الأبيات والأشطار من أدلة صوتية قابلة للقياس.

ما تفعله هذه الوحدة وما لا تفعله (مهم للصدق):
  • تبحث عن K−1 حدًّا داخليًا بين الأبيات (K = عدد الأبيات في النص) تتبع انخفاضات الطاقة
    المنتظمة، بتخطيط ديناميكي يعاقب الابتعاد عن الدورة المتوسطة (قيد البنية: العدد فقط).
    لا يُستعمل طول النص لتوزيع الأزمنة، ولا يُدّعى التحقق من الألفاظ.
  • كل حد يُعلَّم «تقديري» (estimated) مع ثقة وأدلة؛ حدود بلا انخفاض طاقة قريب تُعلَّم «مُستكمَلة».
  • حد الشطر داخل البيت: أقوى دليل صوتي قرب المنتصف (نهاية مدّ ممتد أو انخفاض طاقة)،
    وإلا فمنتصف البيت البنيوي بثقة منخفضة جدًا. لا كلمات ولا مقاطع.
"""
from __future__ import annotations

import numpy as np


# ───────────────────────── حدود الأبيات ─────────────────────────

def _evidence_grid(dips, t0, t1, dt, sigma=0.12):
    g = np.arange(int(np.floor(t0 / dt)), int(np.ceil(t1 / dt)) + 1)
    tg = g * dt
    ev = np.zeros_like(tg)
    for d in dips:
        if d["durationSec"] < 0.06:
            continue
        s = d["strength"]
        ev = np.maximum(ev, s * np.exp(-0.5 * ((tg - d["centerSec"]) / sigma) ** 2))
    return g, tg, ev


def track_verse_boundaries(dips, span, n_verses, *, dt=0.05, dur_slack=1.3, sigma_dur=0.6,
                           w_evidence=1.0, w_duration=1.0):
    """يعيد قائمة n_verses+1 زمنًا: [بداية الأداء, حد1, ..., حد(K−1), نهاية الأداء] بتخطيط ديناميكي."""
    s, e = span
    mean_T = (e - s) / n_verses
    g, tg, ev = _evidence_grid(dips, s - 1.0, e + 1.0, dt)
    G = len(g)
    i0 = int(round(1.0 / dt))
    iK = G - 1 - int(round(1.0 / dt))
    lo_j = int(np.floor((mean_T - dur_slack) / dt))
    hi_j = int(np.ceil((mean_T + dur_slack) / dt))
    js = np.arange(lo_j, hi_j + 1)
    pen = w_duration * ((js * dt - mean_T) / sigma_dur) ** 2
    INF = 1e18
    cost = np.full(G, INF)
    cost[i0] = 0.0
    back = np.zeros((n_verses, G), dtype=np.int16)
    for k in range(1, n_verses + 1):
        new = np.full(G, INF)
        arg = np.zeros(G, dtype=np.int16)
        best = np.full(G, INF)
        for jj, (j, p) in enumerate(zip(js, pen)):
            if j <= 0 or j >= G:
                continue
            cand = np.full(G, INF)
            cand[j:] = cost[: G - j] + p
            better = cand < best
            best = np.where(better, cand, best)
            arg = np.where(better, jj, arg)
        reward = -w_evidence * ev if k < n_verses else np.zeros(G)
        new = best + reward
        if k == n_verses:
            mask = np.full(G, INF)
            mask[iK] = 0.0
            new = new + mask
        back[k - 1] = arg
        cost = new
    # تتبع الرجوع
    path = [iK]
    cur = iK
    for k in range(n_verses, 0, -1):
        j = js[back[k - 1][cur]]
        cur = cur - int(j)
        path.append(cur)
    path = path[::-1]
    times = tg[np.array(path)]
    times[0], times[-1] = s, e
    return [float(x) for x in times]


def boundary_evidence(times, dips, near=0.45):
    """لكل حد داخلي: أقوى انخفاض ضمن ±near ثانية، وثقة بسيطة قابلة للتفسير."""
    out = []
    for k, t in enumerate(times):
        if k == 0 or k == len(times) - 1:
            out.append({"cue": "activity-edge", "strength": 1.0, "dipStartSec": None, "dipEndSec": None,
                        "offsetSec": 0.0, "confidence": 0.9, "interpolated": False})
            continue
        best = None
        for d in dips:
            if abs(d["centerSec"] - t) <= near and d["durationSec"] >= 0.06:
                if best is None or d["strength"] > best["strength"]:
                    best = d
        if best is None:
            out.append({"cue": "none", "strength": 0.0, "dipStartSec": None, "dipEndSec": None,
                        "offsetSec": None, "confidence": 0.25, "interpolated": True})
        else:
            conf = 0.9 if best["strength"] >= 0.8 else (0.6 if best["strength"] >= 0.35 else 0.4)
            out.append({"cue": "energy-dip", "strength": best["strength"],
                        "dipStartSec": best["startSec"], "dipEndSec": best["endSec"],
                        "offsetSec": float(best["centerSec"] - t), "confidence": conf, "interpolated": False})
    return out


# ───────────────────────── حدود الأشطار ─────────────────────────

def hemistich_cut(v_start, v_end, dips, sustains, *, lo=0.38, hi=0.66, prior_center=0.52, prior_w=0.15):
    """يختار زمن نهاية الشطر الأول داخل البيت. يعيد (t, evidence, confidence)."""
    dur = v_end - v_start
    cand = []
    for sus in sustains:
        te = sus["endSec"]
        ph = (te - v_start) / dur
        if lo <= ph <= hi and sus["durationSec"] >= 0.35:
            cand.append({"t": te, "cue": "sustain-end", "s": min(1.0, sus["durationSec"] / 0.9)})
    for d in dips:
        ph = (d["centerSec"] - v_start) / dur
        if lo <= ph <= hi and d["durationSec"] >= 0.06:
            cand.append({"t": d["centerSec"], "cue": "energy-dip", "s": d["strength"]})
    if not cand:
        return v_start + 0.5 * dur, {"cue": "structural-midpoint", "supporting": []}, 0.2
    # دمج الأدلة المتقاربة (≤0.3 ث)
    cand.sort(key=lambda c: c["t"])
    groups, cur = [], [cand[0]]
    for c in cand[1:]:
        if c["t"] - cur[-1]["t"] <= 0.3:
            cur.append(c)
        else:
            groups.append(cur)
            cur = [c]
    groups.append(cur)
    best, best_score = None, -1e9
    for g in groups:
        cues = {c["cue"] for c in g}
        w_s = max((c["s"] for c in g if c["cue"] == "sustain-end"), default=0.0)
        w_d = max((c["s"] for c in g if c["cue"] == "energy-dip"), default=0.0)
        score = 0.6 * w_s + 0.4 * w_d + (0.2 if len(cues) == 2 else 0.0)
        tt = float(np.mean([c["t"] for c in g]))
        ph = (tt - v_start) / dur
        score -= 0.25 * ((ph - prior_center) / prior_w) ** 2
        if score > best_score:
            best, best_score = (tt, g, score), score
    tt, g, score = best
    cues = sorted({c["cue"] for c in g})
    conf = 0.55 if len(cues) == 2 else 0.4
    if score < 0.0:
        conf = 0.25
    return tt, {"cue": "+".join(cues), "supporting": [{"cue": c["cue"], "t": round(c["t"], 3), "s": round(c["s"], 3)} for c in g],
                "score": round(float(score), 3)}, conf


def estimate_verse_period(dips, span, *, min_dur=0.15, lo=5.0, hi=15.0):
    """تقدير عدد الأبيات من انتظام الفجوات وحده (دون استعمال عدد أبيات النص).
    1) مدرج الفروق الزوجية بين مراكز الوقفات في [lo,hi] ⇒ الدورة التقريبية T0.
    2) وسيط الفروق المتتالية القريبة من T0 (±25٪) ⇒ T_med.
    3) N ≈ (نهاية الأداء − بدايته)/T_med.
    يعيد قاموسًا أو None إن تعذّر التقدير."""
    ts = np.array(sorted(d["centerSec"] for d in dips if d["durationSec"] >= min_dur))
    if len(ts) < 6:
        return None
    diffs = []
    for i in range(len(ts)):
        j = i + 1
        while j < len(ts) and ts[j] - ts[i] <= hi:
            if ts[j] - ts[i] >= lo:
                diffs.append(ts[j] - ts[i])
            j += 1
    if not diffs:
        return None
    h, edges = np.histogram(diffs, bins=int((hi - lo) / 0.1), range=(lo, hi))
    t0 = float((edges[np.argmax(h)] + edges[np.argmax(h) + 1]) / 2)
    cons = np.diff(ts)
    near = cons[(cons > 0.75 * t0) & (cons < 1.25 * t0)]
    if len(near) < 5:
        return None
    t_med = float(np.median(near))
    n_est = (span[1] - span[0]) / t_med
    return {"coarsePeriodSec": round(t0, 2), "medianPeriodSec": round(t_med, 3), "spacingsUsed": int(len(near)),
            "nVersesEstimate": round(float(n_est), 2), "nVersesRounded": int(round(n_est))}
