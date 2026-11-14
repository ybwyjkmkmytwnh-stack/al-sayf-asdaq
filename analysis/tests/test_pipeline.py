"""اختبارات خط التحليل الكامل على صوت اصطناعي معروف الحقيقة الأرضية + التخزين المؤقت + رفض بصمة غير مطابقة."""
import hashlib
import json
import wave
from pathlib import Path

import numpy as np
import pytest

from refkit import ANALYSIS_VERSION
from refkit.audio_io import sha256_file, sha256_text
from refkit.pipeline import DEFAULT_SETTINGS, cache_is_valid, pitch_quality, run, settings_hash
from refkit.poem import load_poem, normalize_ar
from refkit.schema import validate
from refkit.align import estimate_verse_period

SR = 16000
VERSE = 3.0
START = 1.0
K = 4


def synth_audio(path: Path, seed=0, f_scale=1.0):
    """K أبيات × 3 ث: نغمة غنية بالتوافقيات بطبقة متغيّرة، وقفة 0.25 ث في آخر كل بيت (ما عدا الأخير)، وصمت 1 ث في الطرفين."""
    n = int((START * 2 + K * VERSE) * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    truth = [START + k * VERSE for k in range(K + 1)]
    for k in range(K):
        a, b = truth[k], truth[k + 1]
        m = (t >= a) & (t < b)
        tt = t[m] - a
        f = f_scale * (150 + 30 * np.sin(2 * np.pi * tt / 1.5 + k))
        ph = 2 * np.pi * np.cumsum(f) / SR
        sig = sum(np.sin(h * ph) / h for h in range(1, 6))
        env = np.ones_like(tt)
        if k < K - 1:
            env[tt > VERSE - 0.25] = 0.02           # وقفة عند الحد
        x[m] = 0.3 * sig / 2 * env
    rng = np.random.default_rng(seed)
    x += 0.0005 * rng.standard_normal(n)
    pcm = np.clip(x, -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((pcm * 32767).astype("<i2").tobytes())
    return truth


def write_poem(path: Path, tag=""):
    lines = [f"السَّيْفُ أَصْدَقُ {i}{tag}" if i % 2 == 0 else f"فِي حَدِّهِ الْحَدُّ {i}{tag}" for i in range(2 * K)]
    doc = {"schemaVersion": "1.0.0", "title": "t", "poet": "p", "source": "test", "hemistichCount": len(lines),
           "verseCount": K, "textHash": sha256_text("\n".join(lines)), "lines": lines}
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    d = tmp_path_factory.mktemp("pipe")
    wav, poem, out = d / "a.wav", d / "poem.json", d / "out.json"
    truth = synth_audio(wav)
    write_poem(poem)
    logs = []
    a, fresh = run(wav, poem, out, force=True, log=logs.append)
    return {"dir": d, "wav": wav, "poem": poem, "out": out, "truth": truth, "a": a, "fresh": fresh}


def test_pipeline_output_valid_and_strict_json(env):
    a = env["a"]
    assert env["fresh"] is True
    assert validate(a) == []
    raw = env["out"].read_text(encoding="utf-8")
    assert "NaN" not in raw and "Infinity" not in raw
    assert a["audioHash"] == sha256_file(env["wav"])
    assert a["analysisVersion"] == ANALYSIS_VERSION
    assert a["frames"]["count"] == len(a["frames"]["columns"]["f0Hz"])
    assert a["scope"]["pronunciationAssessed"] is False


def test_verse_boundaries_match_ground_truth_within_tolerance(env):
    a, truth = env["a"], env["truth"]
    starts = [v["startSec"] for v in a["verses"]]
    ends = [v["endSec"] for v in a["verses"]]
    assert len(a["verses"]) == K
    # البدايات: الأولى = بداية الأداء؛ التالية = نهاية الوقفة (≈ حد الحقيقة + 0.0..0.25)
    assert abs(starts[0] - truth[0]) < 0.15
    for k in range(1, K):
        assert truth[k] - 0.05 <= starts[k] <= truth[k] + 0.05, (k, starts[k], truth[k])
    for k in range(K - 1):
        assert truth[k + 1] - 0.3 <= ends[k] <= truth[k + 1] + 0.05, (k, ends[k], truth[k + 1])
    assert abs(ends[-1] - truth[-1]) < 0.3


def test_all_alignment_is_flagged_estimated_and_words_unmeasured(env):
    a = env["a"]
    for v in a["verses"]:
        assert v["status"] in ("estimated", "unreliable")
        assert len(v["hemistichs"]) == 2
        assert v["hemistichs"][0]["endSec"] == v["hemistichs"][1]["startSec"]
    assert all(w["startSec"] is None and w["status"] == "not-measured" for w in a["words"])
    assert any(w["code"] == "ALIGNMENT_NOT_LEXICALLY_VERIFIED" for w in a["qualityWarnings"])


def test_frames_pitch_matches_synthetic_truth(env):
    a = env["a"]
    c = a["frames"]["columns"]
    hop = a["hopSec"]
    errs = []
    for k in range(K):
        for i in range(int((START + k * VERSE + 0.3) / hop), int((START + k * VERSE + 2.6) / hop)):
            if c["voiced"][i] and c["valid"][i]:
                tt = i * hop - (START + k * VERSE)
                f = 150 + 30 * np.sin(2 * np.pi * tt / 1.5 + k)
                errs.append(abs(1200 * np.log2(c["f0Hz"][i] / f)))
    assert len(errs) > 800
    assert np.median(errs) < 15


def test_cache_reuse_and_reject_on_hash_mismatch(env):
    logs = []
    a2, fresh = run(env["wav"], env["poem"], env["out"], force=False, log=logs.append)
    assert fresh is False and a2["audioHash"] == env["a"]["audioHash"]
    ok, why = cache_is_valid(env["out"], sha256_file(env["wav"]), load_poem(env["poem"])["textHash"], settings_hash(DEFAULT_SETTINGS))
    assert ok, why
    # صوت آخر ⇒ رفض ثم إعادة توليد تلقائية
    wav2 = env["dir"] / "b.wav"
    synth_audio(wav2, seed=5, f_scale=1.3)
    ok, why = cache_is_valid(env["out"], sha256_file(wav2), load_poem(env["poem"])["textHash"], settings_hash(DEFAULT_SETTINGS))
    assert not ok and "audioHash" in why
    a3, fresh3 = run(wav2, env["poem"], env["out"], force=False, log=logs.append)
    assert fresh3 is True and a3["audioHash"] == sha256_file(wav2) != env["a"]["audioHash"]
    # نص آخر ⇒ رفض
    poem2 = env["dir"] / "poem2.json"
    write_poem(poem2, tag="x")
    ok, why = cache_is_valid(env["out"], sha256_file(wav2), load_poem(poem2)["textHash"], settings_hash(DEFAULT_SETTINGS))
    assert not ok and "textHash" in why


def test_tampered_poem_rejected(tmp_path):
    p = tmp_path / "poem.json"
    write_poem(p)
    d = json.loads(p.read_text(encoding="utf-8"))
    d["lines"][0] += "!"
    p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="textHash"):
        load_poem(p)


def test_corrupt_cache_file_is_rejected(tmp_path):
    out = tmp_path / "x.json"
    out.write_text("{not json", encoding="utf-8")
    ok, why = cache_is_valid(out, "0" * 64, "0" * 64, "x")
    assert not ok and "تالف" in why


def test_schema_validator_catches_problems(env):
    import copy
    a = copy.deepcopy(env["a"])
    a["frames"]["columns"]["f0Hz"][5] = float("nan")
    assert any("NaN" in e or "f0" in e for e in validate(a))
    a = copy.deepcopy(env["a"]); a["frames"]["columns"]["voiced"].pop()
    assert any("طول العمود" in e for e in validate(a))
    a = copy.deepcopy(env["a"]); a["verses"][1]["startSec"] = a["verses"][0]["endSec"] - 1
    assert any("تداخل" in e for e in validate(a))
    a = copy.deepcopy(env["a"]); a["audioHash"] = "xyz"
    assert any("SHA-256" in e for e in validate(a))
    a = copy.deepcopy(env["a"]); del a["verses"]
    assert any("verses" in e for e in validate(a))


def test_pitch_quality_penalizes_octave_jumps_and_isolated_frames():
    n = 40
    f0 = np.full(n, 200.0); voiced = np.ones(n, bool); per = np.full(n, 0.95)
    f0[20] = 400.0                           # قفزة أوكتاف معزولة
    q = pitch_quality(f0, voiced, per, 3, 100.0, 400.0, 0.5)
    assert q[10] > 0.9 and q[20] < 0.05
    f1 = np.full(n, np.nan); v1 = np.zeros(n, bool); f1[5] = 200.0; v1[5] = True
    q1 = pitch_quality(f1, v1, per, 3, 100.0, 400.0, 0.5)
    assert q1[5] < 0.5                       # إطار مجهور معزول: جودته مخفّضة


def test_period_estimator_counts_verses_without_text():
    dips = [{"centerSec": 3.0 * k + 0.4 * ((k * 7) % 3 - 1) * 0.05, "durationSec": 0.25} for k in range(1, 30)]
    est = estimate_verse_period(dips, (0.0, 3.0 * 30), lo=1.5, hi=6.0)
    assert est and abs(est["medianPeriodSec"] - 3.0) < 0.1 and est["nVersesRounded"] == 30


def test_normalize_arabic_for_search():
    assert normalize_ar("السَّيْفُ أَصْدَقُ إِنْبَاءً") == "السيف اصدق انباء"
    assert normalize_ar("ٱلْكِتَابُ") == "الكتاب"


REAL = Path(__file__).resolve().parents[2] / "web" / "data" / "reference_analysis.json"
MP3 = Path(__file__).resolve().parents[2] / "web" / "audio" / "reference.mp3"


@pytest.mark.skipif(not (REAL.exists() and MP3.exists()), reason="ملف التحليل الحقيقي غير موجود")
def test_real_analysis_matches_attached_mp3_and_is_valid():
    a = json.loads(REAL.read_text(encoding="utf-8"))
    assert a["audioHash"] == sha256_file(MP3)
    assert validate(a) == []
    assert len(a["verses"]) == 71 and len(a["words"]) == 778
    est = a["stats"]["alignmentSelfConsistency"]["acousticPeriodEstimate"]
    assert est["nVersesRounded"] == 71
    ok, why = cache_is_valid(REAL, sha256_file(MP3), a["textHash"], settings_hash(DEFAULT_SETTINGS))
    assert ok, why
