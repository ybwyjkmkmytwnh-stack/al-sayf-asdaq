"""اختبارات pYIN على إشارات اصطناعية معروفة الحقيقة الأرضية.

الغرض: إثبات أن المقدّر دقيق بالسنت، وأنه لا يختلق طبقة في الصمت/الضوضاء،
وأنه لا ينتج NaN خارج حقل f0 (الذي يحمل NaN عمدًا حيث لا جهر ويُحوَّل إلى null عند الحفظ).
"""
import numpy as np
import pytest

from refkit.pyin import PyinParams, analyze

SR = 16000


def harmonic(f_of_t, dur, sr=SR, n_harm=6, amp=0.3):
    t = np.arange(int(dur * sr)) / sr
    ph = 2 * np.pi * np.cumsum(f_of_t(t)) / sr
    x = np.zeros_like(t)
    for h in range(1, n_harm + 1):
        x += (1.0 / h) * np.sin(h * ph)
    return amp * x / np.max(np.abs(x))


def cents(a, b):
    return 1200.0 * np.log2(a / b)


def test_steady_tone_accuracy_in_cents():
    x = harmonic(lambda t: np.full_like(t, 180.0), 1.5)
    r = analyze(x)
    sel = (r.times > 0.15) & (r.times < 1.35)
    assert r.voiced[sel].mean() > 0.97
    err = cents(r.f0[sel & r.voiced], 180.0)
    assert np.abs(np.median(err)) < 5.0
    assert np.percentile(np.abs(err), 95) < 15.0


@pytest.mark.parametrize("f0", [90.0, 130.0, 220.0, 330.0, 500.0])
def test_range_of_pitches_no_octave_errors(f0):
    x = harmonic(lambda t: np.full_like(t, f0), 1.2)
    r = analyze(x)
    sel = (r.times > 0.15) & (r.times < 1.05) & r.voiced
    assert sel.sum() > 70
    err = np.abs(cents(r.f0[sel], f0))
    assert np.mean(err > 100.0) < 0.02, f"octave/gross errors at {f0} Hz"
    assert np.median(err) < 10.0


def test_glide_tracks_within_tolerance():
    # انزلاق خطي في الأوكتاف: 150 → 300 هرتز خلال 2 ث (سرعة 0.5 أوكتاف/ث)
    f = lambda t: 150.0 * 2.0 ** (t / 2.0)
    x = harmonic(f, 2.0)
    r = analyze(x)
    sel = (r.times > 0.15) & (r.times < 1.85) & r.voiced
    truth = f(r.times[sel])
    err = cents(r.f0[sel], truth)
    assert sel.sum() > 150
    assert np.percentile(np.abs(err), 90) < 30.0


def test_silence_is_unvoiced_and_f0_nan():
    r = analyze(np.zeros(SR))
    assert not r.voiced.any()
    assert np.isnan(r.f0).all()
    assert np.isfinite(r.voiced_prob).all()
    assert np.isfinite(r.frame_rms_db).all()


def test_white_noise_mostly_unvoiced():
    rng = np.random.default_rng(1)
    x = 0.1 * rng.standard_normal(2 * SR)
    r = analyze(x)
    assert r.voiced.mean() < 0.15


def test_tone_then_silence_then_tone_boundaries():
    a = harmonic(lambda t: np.full_like(t, 200.0), 0.8)
    x = np.concatenate([a, np.zeros(int(0.6 * SR)), a])
    r = analyze(x)
    gap = (r.times > 0.95) & (r.times < 1.25)
    assert r.voiced[gap].mean() < 0.1
    on1 = (r.times > 0.1) & (r.times < 0.7)
    on2 = (r.times > 1.55) & (r.times < 2.1)
    assert r.voiced[on1].mean() > 0.95
    assert r.voiced[on2].mean() > 0.95


def test_frame_grid_is_hop_aligned():
    x = harmonic(lambda t: np.full_like(t, 200.0), 1.0)
    r = analyze(x, PyinParams(hop_s=0.010))
    assert np.allclose(np.diff(r.times), 0.010)
    assert r.times[0] == 0.0


def test_no_nan_outside_f0():
    x = harmonic(lambda t: 160.0 + 20.0 * np.sin(2 * np.pi * 5 * t), 1.0)
    r = analyze(x)
    for name in ("voiced_prob", "frame_rms_db"):
        assert np.isfinite(getattr(r, name)).all(), name
    v = r.voiced
    assert np.isfinite(r.f0[v]).all()
    assert np.isnan(r.f0[~v]).all()
    assert np.isfinite(r.periodicity[v]).all()
