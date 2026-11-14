"""خط التحليل المرجعي الكامل: صوت + نص → reference_analysis.json (مع تخزين مؤقت ورفض عند اختلاف البصمات)."""
from __future__ import annotations

import json
import time
import warnings
from pathlib import Path

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from . import ANALYSIS_VERSION, SCHEMA_VERSION
from .align import boundary_evidence, estimate_verse_period, hemistich_cut, track_verse_boundaries
from .audio_io import decode_mono, probe, sha256_file, sha256_text
from .features import frame_energy_db, runs
from .poem import build_structure, load_poem
from .pyin import PyinParams, analyze as pyin_analyze
from .schema import validate
from .segments import active_span, detect_dips, detect_onsets, detect_sustains

INVALID_REASONS = {"0": "none", "1": "unreliable-pitch", "2": "outside-performance"}

DEFAULT_SETTINGS = {
    "pyin": PyinParams().to_dict(),
    "energy": {"windowSec": 0.04, "windowKind": "rect-centered", "unit": "dB re 1.0 full-scale RMS", "floorDb": -120.0},
    "validity": {"minPitchQuality": 0.35, "neighborFrames": 3, "continuityFullCents": 100.0,
                 "continuityZeroCents": 400.0, "isolatedPenalty": 0.5},
    "activity": {"onDb": -35.0, "minOnSec": 0.15},
    "dips": {"relDepthDb": 15.0, "minDurSec": 0.05, "baselineWindowSec": 3.0},
    "pauseEventMinSec": 0.15,
    "sustain": {"minDurSec": 0.40, "tolCents": 70.0},
    "onsets": {"riseDb": 8.0, "withinSec": 0.08},
    "alignment": {"method": "dp-energy-dips+structure-count", "stepSec": 0.05, "durSlackSec": 1.3,
                  "sigmaDurSec": 0.6, "hemistichWindow": [0.38, 0.66], "hemistichPriorCenter": 0.52,
                  "wordTiming": "not-measured"},
}


def settings_hash(settings: dict) -> str:
    return sha256_text(json.dumps(settings, sort_keys=True, ensure_ascii=False) + "|" + ANALYSIS_VERSION)


def cache_is_valid(out_path: Path, audio_hash: str, text_hash: str, s_hash: str) -> tuple[bool, str]:
    if not out_path.exists():
        return False, "لا ملف تحليل سابق"
    try:
        a = json.loads(out_path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        return False, f"ملف التحليل تالف: {e}"
    if a.get("analysisVersion") != ANALYSIS_VERSION:
        return False, "analysisVersion مختلف"
    if a.get("audioHash") != audio_hash:
        return False, "audioHash لا يطابق الصوت الحالي (التحليل لتسجيل آخر)"
    if a.get("textHash") != text_hash:
        return False, "textHash لا يطابق النص الحالي"
    if a.get("settingsHash") != s_hash:
        return False, "الإعدادات تغيّرت"
    errs = validate(a)
    if errs:
        return False, "فشل التحقق من المخطط: " + errs[0]
    return True, "التحليل المخزَّن صالح"


def pitch_quality(f0, voiced, periodicity, nb, full, zero, iso_pen):
    n = len(f0)
    cents = np.full(n, np.nan)
    m = voiced & np.isfinite(f0)
    cents[m] = 1200.0 * np.log2(f0[m] / 100.0)
    pad = np.full(nb, np.nan)
    win = sliding_window_view(np.concatenate([pad, cents, pad]), 2 * nb + 1)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        med = np.nanmedian(win, axis=1)
    cnt = np.sum(np.isfinite(win), axis=1)
    jump = np.abs(cents - med)
    cont = np.clip(1.0 - (jump - full) / (zero - full), 0.0, 1.0)
    cont = np.where(cnt >= 3, cont, cont * iso_pen)
    q = np.where(m, np.nan_to_num(periodicity, nan=0.0) * cont, np.nan)
    return q


def _r(x, nd):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def run(audio_path, poem_path, out_path, *, force=False, log=print, settings=None):
    t_start = time.time()
    audio_path, poem_path, out_path = Path(audio_path), Path(poem_path), Path(out_path)
    S = json.loads(json.dumps(settings or DEFAULT_SETTINGS))
    pp = PyinParams(**S["pyin"])
    audio_hash = sha256_file(audio_path)
    poem = load_poem(poem_path)
    text_hash = poem["textHash"]
    s_hash = settings_hash(S)
    if not force:
        ok, why = cache_is_valid(out_path, audio_hash, text_hash, s_hash)
        log(f"[cache] {why}")
        if ok:
            return json.loads(out_path.read_text(encoding="utf-8")), False
    log(f"[1/6] فك الترميز وبصمة الصوت (sha256={audio_hash[:12]}…)")
    info = probe(audio_path)
    x = decode_mono(audio_path, pp.sr)
    dur = len(x) / pp.sr
    peak = float(np.max(np.abs(x)))
    log(f"      المدة {dur:.3f}ث (ffprobe {info.duration_sec:.3f}ث)، ذروة بعد الفك {peak:.2f}")

    log("[2/6] pYIN (طبقة/جهر/دورية)")
    r = pyin_analyze(x, pp)
    n = len(r.times)
    t = r.times

    log("[3/6] الطاقة والصلاحية والجودة")
    db = frame_energy_db(x, pp.sr, pp.hop_s, S["energy"]["windowSec"], n)
    span = active_span(db, pp.hop_s, S["activity"]["onDb"], S["activity"]["minOnSec"])
    if span is None:
        raise RuntimeError("لم يُعثر على نشاط صوتي في التسجيل")
    s0, e0 = span
    v = S["validity"]
    q = pitch_quality(r.f0, r.voiced, r.periodicity, v["neighborFrames"], v["continuityFullCents"],
                      v["continuityZeroCents"], v["isolatedPenalty"])
    perf = (t >= s0) & (t <= e0)
    valid = np.ones(n, dtype=np.int8)
    reason = np.zeros(n, dtype=np.int8)
    valid[~perf] = 0
    reason[~perf] = 2
    unrel = perf & r.voiced & (np.nan_to_num(q, nan=0.0) < v["minPitchQuality"])
    valid[unrel] = 0
    reason[unrel] = 1
    usable_pitch = r.voiced & (valid == 1)

    log("[4/6] وقفات/مدود/بدايات")
    d = S["dips"]
    dips = detect_dips(db, pp.hop_s, s0, e0, d["relDepthDb"], d["minDurSec"])
    sus_all = detect_sustains(np.where(usable_pitch, r.f0, np.nan), usable_pitch, pp.hop_s,
                              S["sustain"]["minDurSec"], S["sustain"]["tolCents"])
    ons = detect_onsets(db, r.voiced, pp.hop_s, s0, e0, S["onsets"]["riseDb"], S["onsets"]["withinSec"])
    pauses = [x_ for x_ in dips if x_["durationSec"] >= S["pauseEventMinSec"]]

    log("[5/6] محاذاة الأبيات والأشطار (بنيوية صوتية، تقديرية)")
    verses_tpl, hemis_tpl, words = build_structure(poem)
    K = len(verses_tpl)
    # نطاق البحث عن الدورة واسع (×0.5..×2 حول المتوسط المتوقع) فلا يفرض العدد؛ العدد يُقدَّر من الفجوات المقيسة
    period = estimate_verse_period(dips, span, lo=0.5 * (e0 - s0) / K, hi=2.0 * (e0 - s0) / K)
    vb = track_verse_boundaries(dips, span, K, dt=S["alignment"]["stepSec"],
                                dur_slack=S["alignment"]["durSlackSec"], sigma_dur=S["alignment"]["sigmaDurSec"])
    ev = boundary_evidence(vb, dips)
    verses = []
    n_weak = 0
    for k in range(K):
        start = ev[k]["dipEndSec"] if (k > 0 and ev[k]["dipEndSec"] is not None) else vb[k]
        end = ev[k + 1]["dipStartSec"] if (k + 1 < K and ev[k + 1]["dipStartSec"] is not None) else vb[k + 1]
        if not start < end:
            start, end = vb[k], vb[k + 1]
        inner = [x_ for x_ in dips if start < x_["centerSec"] < end]
        inner_sus = [x_ for x_ in sus_all if start < x_["endSec"] < end]
        tcut, cut_ev, cut_conf = hemistich_cut(start, end, inner, inner_sus, lo=S["alignment"]["hemistichWindow"][0],
                                               hi=S["alignment"]["hemistichWindow"][1],
                                               prior_center=S["alignment"]["hemistichPriorCenter"])
        c_start, c_end = ev[k]["confidence"], ev[k + 1]["confidence"]
        h1c, h2c = min(c_start, cut_conf), min(cut_conf, c_end)
        vc = min(c_start, c_end)

        def st(c):
            return "unreliable" if c <= 0.25 else "estimated"

        hs = []
        for idx, (hs_, he_, conf, edges) in enumerate([
                (start, tcut, h1c, {"start": ev[k], "end": cut_ev}),
                (tcut, end, h2c, {"start": cut_ev, "end": ev[k + 1]})]):
            tpl = hemis_tpl[2 * k + idx]
            hs.append({"id": tpl["id"], "index": tpl["index"], "indexInVerse": idx, "text": tpl["text"],
                       "normalizedText": tpl["normalizedText"], "startSec": round(hs_, 3), "endSec": round(he_, 3),
                       "status": st(conf), "alignmentConfidence": round(conf, 2),
                       "timingSource": "acoustic-structure", "evidence": edges})
        if st(vc) == "unreliable" or any(h["status"] == "unreliable" for h in hs):
            n_weak += 1
        verses.append({"id": verses_tpl[k]["id"], "index": k, "startSec": round(start, 3), "endSec": round(end, 3),
                       "status": st(vc), "alignmentConfidence": round(vc, 2), "timingSource": "acoustic-structure",
                       "boundaryEvidence": {"start": ev[k], "end": ev[k + 1]}, "hemistichs": hs})

    log("[6/6] تجميع الملف والتحقق")
    f0_out = [None if (not np.isfinite(a)) else round(float(a), 2) for a in r.f0]
    cols = {
        "f0Hz": f0_out,
        "voiced": [int(b) for b in r.voiced],
        "voicingProbability": [round(float(a), 3) for a in r.voiced_prob],
        "pitchQuality": [None if not np.isfinite(a) else round(float(a), 3) for a in q],
        "energyDb": [round(float(a), 1) for a in db],
        "valid": [int(b) for b in valid],
        "invalidReason": [int(b) for b in reason],
    }
    regions = [
        {"type": "silence", "startSec": 0.0, "endSec": round(s0, 3), "reason": "before-performance"},
        {"type": "performance", "startSec": round(s0, 3), "endSec": round(e0, 3)},
        {"type": "silence", "startSec": round(e0, 3), "endSec": round(dur, 3), "reason": "after-performance"},
    ]
    for i, j in runs(unrel):
        if (j - i) >= 5:
            regions.append({"type": "unreliable", "startSec": round(i * pp.hop_s, 3), "endSec": round(j * pp.hop_s, 3),
                            "reason": "unreliable-pitch"})
    regions.sort(key=lambda g: (g["startSec"], g["endSec"]))
    events = (
        [{"type": "pause", "startSec": round(x_["startSec"], 3), "endSec": round(x_["endSec"], 3),
          "durationSec": round(x_["durationSec"], 3), "depthDb": round(x_["depthDb"], 1)} for x_ in pauses] +
        [{"type": "sustain", "startSec": round(x_["startSec"], 3), "endSec": round(x_["endSec"], 3),
          "durationSec": round(x_["durationSec"], 3), "medianHz": round(x_["medianHz"], 2)} for x_ in sus_all] +
        [{"type": "onset", "timeSec": round(x_["timeSec"], 3), "riseDb": round(x_["riseDb"], 1),
          "voiced": x_["voiced"]} for x_ in ons])
    events.sort(key=lambda e: e.get("startSec", e.get("timeSec")))

    vm = usable_pitch
    stats = {
        "performanceStartSec": round(s0, 3), "performanceEndSec": round(e0, 3),
        "voicedFractionInPerformance": round(float(np.mean(r.voiced[perf])), 4),
        "usablePitchFractionInPerformance": round(float(np.mean(usable_pitch[perf])), 4),
        "f0Hz": {f"p{p}": round(float(np.percentile(r.f0[vm], p)), 2) for p in (5, 25, 50, 75, 95)},
        "energyDbVoiced": {f"p{p}": round(float(np.percentile(db[vm], p)), 1) for p in (10, 50, 90)},
        "decodedPeakAbs": round(peak, 3),
    }
    stats["energyDbVoiced"]["spread10to90"] = round(stats["energyDbVoiced"]["p90"] - stats["energyDbVoiced"]["p10"], 1)
    stats["medianCentsRe100Hz"] = round(1200.0 * float(np.log2(stats["f0Hz"]["p50"] / 100.0)), 1)

    # مقاييس اتساق ذاتي للمحاذاة (ليست دقة مقابل حقيقة أرضية!)
    vdur = np.diff([vb[0]] + [vb[k] for k in range(1, K)] + [vb[K]])
    cut_ph = np.array([(verses[k]["hemistichs"][0]["endSec"] - verses[k]["startSec"]) /
                       (verses[k]["endSec"] - verses[k]["startSec"]) for k in range(K)])
    stats["alignmentSelfConsistency"] = {
        "verseDurationSec": {"min": round(float(vdur.min()), 2), "median": round(float(np.median(vdur)), 2),
                             "max": round(float(vdur.max()), 2)},
        "boundariesWithDipEvidence": int(sum(1 for e_ in ev[1:-1] if e_["cue"] == "energy-dip")),
        "boundariesWithoutEvidence": int(sum(1 for e_ in ev[1:-1] if e_["cue"] == "none")),
        "hemistichCutPhase": {"mean": round(float(cut_ph.mean()), 3), "std": round(float(cut_ph.std()), 3)},
        "versesWithWeakEvidence": int(n_weak),
        "acousticPeriodEstimate": period,
        "note": "اتساق داخلي فقط؛ ليس دقةً مقاسةً مقابل توقيت مُتحقَّق منه بشريًا"}

    low_conf_verses = [v_["id"] for v_ in verses if v_["status"] == "unreliable" or
                       any(h["status"] == "unreliable" for h in v_["hemistichs"])]
    unrel_sec = float(np.sum(unrel) * pp.hop_s)
    warnings_out = [
        {"code": "ALIGNMENT_NOT_LEXICALLY_VERIFIED", "severity": "warn",
         "message": "حدود الأبيات والأشطار مستنتجة من بنية الطاقة والطبقة في التسجيل (فجوات منتظمة ≈ كل بيت)، "
                    "ولم يُتحقق من الألفاظ المنطوقة لعدم توفر تعرّف كلام في بيئة البناء. راجعها في محرر التوقيت.",
         "detail": {"verseCountFromText": K, "acousticPeriodEstimate": period,
                    "countConsistent": bool(period is not None and period["nVersesRounded"] == K)}},
        {"code": "WORD_TIMING_NOT_MEASURED", "severity": "info",
         "message": "لا توقيت للكلمات: لا يوجد قياس صوتي موثوق لها، والتوزيع بحسب طول النص غير مسموح به.",
         "detail": {"words": len(words)}},
        {"code": "HEMISTICH_BOUNDARY_ESTIMATED", "severity": "warn",
         "message": "لا توجد وقفة صوتية ثابتة بين الشطرين؛ حد الشطر تقدير من أقوى دليل صوتي قرب منتصف البيت.",
         "detail": {"structuralMidpointCount": int(sum(1 for v_ in verses if v_["hemistichs"][0]["evidence"]["end"]["cue"] == "structural-midpoint"))}},
        {"code": "LOW_CONFIDENCE_TIMING", "severity": "warn" if low_conf_verses else "info",
         "message": f"أبيات ذات أدلة توقيت ضعيفة: {len(low_conf_verses)}.",
         "detail": {"verseIds": low_conf_verses}},
        {"code": "UNRELIABLE_PITCH_FRAMES", "severity": "info",
         "message": f"أُهملت في التقييم إطارات طبقة غير موثوقة (≈{unrel_sec:.1f} ثانية).",
         "detail": {"seconds": round(unrel_sec, 2)}},
    ]
    if stats["energyDbVoiced"]["spread10to90"] < 12.0:
        warnings_out.append({
            "code": "LOW_REFERENCE_DYNAMIC_RANGE", "severity": "info",
            "message": "التسجيل المرجعي عالي المستوى ومضغوط الديناميكا (مدى 10–90٪ ضيق)؛ لذا فمؤشر القوة النسبية محدود التمييز. وزنه في التقييم ثابت وتجريبي (0.15) ولا يتكيّف مع هذا التحذير.",
            "detail": {"spread10to90Db": stats["energyDbVoiced"]["spread10to90"]}})
    if peak > 1.0:
        warnings_out.append({
            "code": "DECODE_OVERSHOOT", "severity": "info",
            "message": "بعد فك MP3 تتجاوز الذروة 1.0 (تجاوز ترميز لا قصّ حقيقي)، ولا يؤثر على تحليل الطبقة.",
            "detail": {"peakAbs": round(peak, 3)}})

    analysis = {
        "schemaVersion": SCHEMA_VERSION, "audioHash": audio_hash, "textHash": text_hash,
        "analysisVersion": ANALYSIS_VERSION, "settingsHash": s_hash,
        "durationSec": round(dur, 4), "probeDurationSec": round(info.duration_sec, 4),
        "sampleRate": pp.sr, "hopSec": pp.hop_s,
        "timeOrigin": 0.0, "timeOriginMeasured": False,
        "timeOriginNote": "إزاحة (ث) تُضاف لزمن إطار التحليل للحصول على audio.currentTime. القيمة 0 غير مقيسة (timeOriginMeasured=false) ولا تعتمد عليها المزامنة الحية: تُقاس الإزاحة الفعلية كل ثانية بربط غلاف طاقة المرجع الملتقَط في المتصفح بغلاف طاقة التحليل.",
        "frameTimeConvention": "t_i = i*hopSec يمثّل مركز نافذة الإطار؛ المقدّر الحي يستعمل الاصطلاح نفسه",
        "settings": S,
        "frames": {"count": n, "hopSec": pp.hop_s, "t0Sec": 0.0,
                   "encoding": "columnar: columns[name][i]؛ voiced/valid أعداد 0/1؛ null = غير متاح؛ invalidReason رمز عددي (انظر invalidReasons)",
                   "invalidReasons": INVALID_REASONS, "columns": cols},
        "segments": {"regions": regions, "events": events},
        "verses": verses, "words": words, "stats": stats, "qualityWarnings": warnings_out,
        "generator": {"tool": "refkit", "elapsedSec": None},
        "scope": {"assessment": "performance-similarity", "label": "تقييم تشابه الأداء الصوتي",
                  "pronunciationAssessed": False, "harakatAssessed": False, "prosodyAssessed": False},
    }
    analysis["generator"]["elapsedSec"] = round(time.time() - t_start, 1)
    errs = validate(analysis)
    if errs:
        raise RuntimeError("فشل التحقق من مخطط التحليل: " + "; ".join(errs[:5]))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(analysis, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
                        encoding="utf-8")
    log(f"      كُتب {out_path} ({out_path.stat().st_size/1e6:.2f} MB) في {time.time()-t_start:.1f}ث")
    return analysis, True
