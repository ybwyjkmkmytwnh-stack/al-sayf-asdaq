"""مدقّق مخطط ملف التحليل المرجعي (بلا اعتماد على مكتبات خارجية).

يعيد قائمة مشكلات (فارغة = سليم). يُستعمل في خط التحليل بعد الكتابة، وفي الاختبارات،
وله مقابل في الواجهة (web/js/core/analysis.js) عند التحميل.
"""
from __future__ import annotations

import math
import re

HEX64 = re.compile(r"^[0-9a-f]{64}$")

REQUIRED_TOP = ["schemaVersion", "audioHash", "textHash", "analysisVersion", "durationSec", "sampleRate",
                "hopSec", "timeOrigin", "settings", "frames", "segments", "verses", "words", "qualityWarnings"]
FRAME_COLS = ["f0Hz", "voiced", "voicingProbability", "pitchQuality", "energyDb", "valid", "invalidReason"]


def _finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _has_nonfinite(obj, path="$", out=None, limit=5):
    out = [] if out is None else out
    if len(out) >= limit:
        return out
    if isinstance(obj, float) and not math.isfinite(obj):
        out.append(path)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            _has_nonfinite(v, f"{path}.{k}", out, limit)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _has_nonfinite(v, f"{path}[{i}]", out, limit)
            if len(out) >= limit:
                break
    return out


def validate(a: dict) -> list[str]:
    errs: list[str] = []
    for k in REQUIRED_TOP:
        if k not in a:
            errs.append(f"حقل مطلوب مفقود: {k}")
    if errs:
        return errs
    for k in ("audioHash", "textHash"):
        if not (isinstance(a[k], str) and HEX64.match(a[k])):
            errs.append(f"{k} ليس SHA-256 سداسيًا صالحًا")
    for k in ("durationSec", "sampleRate", "hopSec"):
        if not (_finite(a[k]) and a[k] > 0):
            errs.append(f"{k} غير صالح")
    if not _finite(a["timeOrigin"]):
        errs.append("timeOrigin غير صالح")
    bad = _has_nonfinite(a)
    if bad:
        errs.append(f"قيم NaN/Inf في: {bad}")

    fr = a["frames"]
    n = fr.get("count")
    cols = fr.get("columns", {})
    if not isinstance(n, int) or n <= 0:
        errs.append("frames.count غير صالح")
    else:
        if abs(fr.get("hopSec", 0) - a["hopSec"]) > 1e-12:
            errs.append("frames.hopSec لا يطابق hopSec")
        for c in FRAME_COLS:
            if c not in cols:
                errs.append(f"عمود إطارات مفقود: {c}")
            elif len(cols[c]) != n:
                errs.append(f"طول العمود {c} = {len(cols[c])} ≠ {n}")
        if not errs:
            f0, vo, vp, pq = cols["f0Hz"], cols["voiced"], cols["voicingProbability"], cols["pitchQuality"]
            en, va, rs = cols["energyDb"], cols["valid"], cols["invalidReason"]
            for i in range(n):
                if vo[i] == 1 and f0[i] is None:
                    errs.append(f"إطار {i}: voiced بلا f0")
                if vo[i] == 0 and f0[i] is not None:
                    errs.append(f"إطار {i}: f0 بلا voiced")
                if f0[i] is not None and not (_finite(f0[i]) and f0[i] > 0):
                    errs.append(f"إطار {i}: f0 غير صالح")
                if not _finite(en[i]):
                    errs.append(f"إطار {i}: energyDb غير منتهية")
                if vp[i] is not None and not (0.0 <= vp[i] <= 1.0):
                    errs.append(f"إطار {i}: voicingProbability خارج [0,1]")
                if pq[i] is not None and not (0.0 <= pq[i] <= 1.0):
                    errs.append(f"إطار {i}: pitchQuality خارج [0,1]")
                if va[i] == 1 and rs[i] != 0:
                    errs.append(f"إطار {i}: valid مع invalidReason")
                if va[i] == 0 and rs[i] == 0:
                    errs.append(f"إطار {i}: غير صالح بلا سبب")
                if len(errs) > 20:
                    errs.append("… أخطاء أكثر محذوفة")
                    break

    prev_end = -1.0
    seen_h = 0
    for v in a["verses"]:
        for k in ("id", "index", "startSec", "endSec", "status", "alignmentConfidence", "hemistichs"):
            if k not in v:
                errs.append(f"بيت {v.get('id')}: حقل مفقود {k}")
        if errs and any("حقل مفقود" in e for e in errs[-3:]):
            continue
        if not (v["startSec"] < v["endSec"]):
            errs.append(f"بيت {v['id']}: بداية ≥ نهاية")
        if v["startSec"] < prev_end - 1e-9:
            errs.append(f"بيت {v['id']}: تداخل مع السابق")
        prev_end = v["endSec"]
        if v["status"] not in ("estimated", "manual", "unreliable"):
            errs.append(f"بيت {v['id']}: status غير معروف")
        hs = v["hemistichs"]
        if len(hs) != 2:
            errs.append(f"بيت {v['id']}: يجب شطران")
        hp = v["startSec"] - 1e-9
        for h in hs:
            seen_h += 1
            if not (h["startSec"] < h["endSec"]):
                errs.append(f"شطر {h['id']}: بداية ≥ نهاية")
            if h["startSec"] < hp or h["endSec"] > v["endSec"] + 1e-9:
                errs.append(f"شطر {h['id']}: خارج حدود البيت أو متداخل")
            hp = h["endSec"]
            if h["status"] not in ("estimated", "manual", "unreliable"):
                errs.append(f"شطر {h['id']}: status غير معروف")
    for w in a["words"]:
        if w["startSec"] is not None or w["endSec"] is not None:
            if w.get("timingSource") in (None, "none") or w.get("alignmentConfidence") is None:
                errs.append(f"كلمة {w['id']}: توقيت بلا مصدر/ثقة")
    return errs
