"""يولّد ملفات الميكروفون الوهمي للاختبار (WAV 16-bit) في مجلد مؤقت. ليست أصواتًا بشرية: نغمة/صمت/ضجيج + مقطع من المرجع."""
from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import numpy as np

SR = 48000


def _write(path: Path, x: np.ndarray, sr: int = SR):
    pcm = np.clip(x, -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((pcm * 32767).astype("<i2").tobytes())


def make_media(out: Path, ref_mp3: Path) -> dict[str, Path]:
    out.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(SR * 12)) / SR
    tone = sum(np.sin(2 * np.pi * 220.0 * k * t) / k for k in range(1, 6))
    tone = 0.1 * tone / np.sqrt(np.mean(tone ** 2)) * 1.0  # RMS = 0.1 (−20 dBFS)
    files = {"tone": out / "mic_tone.wav", "silence": out / "mic_silence.wav", "noise": out / "mic_noise.wav", "voice": out / "mic_voice.wav"}
    _write(files["tone"], tone)
    _write(files["silence"], np.zeros_like(t))
    rng = np.random.default_rng(1)
    _write(files["noise"], 0.01 * rng.standard_normal(t.size))   # RMS 0.01 (−40 dBFS)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", "30", "-t", "70", "-i", str(ref_mp3), "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", str(files["voice"])], check=True)
    # ملف «تدفق المعايرة»: خلفية هادئة (−62 dBFS) لقياس الضجيج ثم كلام (مقطع من المرجع) لمعايرة الصوت ثم هدوء لفحص التسرّب ثم كلام للتدريب.
    # الجدول الزمني (ثوانٍ منذ فتح الميكروفون): 0–4 هدوء | 4–10.3 كلام | 10.3–26.3 هدوء | 26.3–86.3 كلام.
    def seg(ss, dur):
        tmp = out / f"_seg_{ss}.wav"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(ss), "-t", str(dur), "-i", str(ref_mp3), "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", str(tmp)], check=True)
        with wave.open(str(tmp), "rb") as w:
            return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float64) / 32768.0
    rng2 = np.random.default_rng(7)
    quiet = lambda sec: 0.0008 * rng2.standard_normal(int(SR * sec))
    flow = np.concatenate([quiet(4.0), seg(40, 6.3), quiet(16.0), seg(50, 60.0)])
    files["flow"] = out / "mic_flow.wav"
    _write(files["flow"], flow)
    return files
