"""قراءة الصوت المرجعي: بصمة SHA-256 + فك الترميز عبر ffmpeg إلى float32 أحادي.

لا يُنفَّذ أي تحويل غير موثَّق: الصوت الأصلي يبقى كما هو في web/audio/reference.mp3
(التحليل يعمل على نسخة مفكوكة أحادية فقط، ولا يُعاد ترميز أي شيء للتشغيل).
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass
class ProbeInfo:
    duration_sec: float
    sample_rate: int
    channels: int
    codec: str
    start_time_sec: float
    bit_rate: int | None


def probe(path: str | Path) -> ProbeInfo:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=codec_name,sample_rate,channels,start_time,duration,bit_rate:format=duration",
         "-of", "json", str(path)],
        check=True, capture_output=True, text=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    dur = float(s.get("duration") or j["format"]["duration"])
    return ProbeInfo(
        duration_sec=dur, sample_rate=int(s["sample_rate"]), channels=int(s["channels"]),
        codec=s["codec_name"], start_time_sec=float(s.get("start_time", 0.0)),
        bit_rate=int(s["bit_rate"]) if s.get("bit_rate") else None)


def decode_mono(path: str | Path, sr: int) -> np.ndarray:
    """يفك الترميز إلى float32 أحادي بمعدل sr. القنوات تُجمع بمتوسط متساوٍ (سلوك ffmpeg الافتراضي لـ -ac 1)."""
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1",
           "-ar", str(sr), "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    x = np.frombuffer(raw, dtype="<f4").astype(np.float64)
    if not np.all(np.isfinite(x)):
        raise ValueError("الصوت المفكوك يحوي قيمًا غير منتهية")
    return x
