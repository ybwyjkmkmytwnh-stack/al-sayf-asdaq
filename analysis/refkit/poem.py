"""نص القصيدة: تحميل، تطبيع للبحث، بنية أبيات/أشطار/كلمات، وبصمة النص."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .audio_io import sha256_text

_TASHKEEL = re.compile("[ً-ٰٟـ]")
_ALEF = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه"})


def normalize_ar(text: str) -> str:
    """تطبيع للبحث/المطابقة: حذف التشكيل والتطويل، توحيد الألف والياء/الألف المقصورة والتاء المربوطة."""
    return _TASHKEEL.sub("", text).translate(_ALEF)


def load_poem(path: str | Path) -> dict:
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    lines = doc["lines"]
    if len(lines) % 2:
        raise ValueError("عدد الأشطار يجب أن يكون زوجيًا (شطران لكل بيت)")
    want = sha256_text("\n".join(lines))
    if doc.get("textHash") != want:
        raise ValueError("textHash في poem.json لا يطابق النص: الملف تغيّر بعد الاستخراج")
    return doc


_NUCLEUS = re.compile("[ًٌٍَُِ]")


def build_structure(doc: dict):
    """يعيد (verses, hemistichs, words) بلا أي أزمنة (تُملأ لاحقًا من المحاذاة)."""
    lines = doc["lines"]
    hemis, words, verses = [], [], []
    for hi, text in enumerate(lines):
        vi = hi // 2
        hid = f"h{hi + 1:03d}"
        hemis.append({
            "id": hid, "index": hi, "verseIndex": vi, "verseId": f"v{vi + 1:02d}",
            "indexInVerse": hi % 2, "text": text, "normalizedText": normalize_ar(text),
            "syllableNuclei": len(_NUCLEUS.findall(text)),
        })
        for wi, w in enumerate(text.split()):
            words.append({
                "id": f"w{hi + 1:03d}_{wi + 1:02d}", "verseId": f"v{vi + 1:02d}", "hemistichId": hid,
                "originalText": w, "normalizedText": normalize_ar(w),
                # لا قياس زمني للكلمات: التوزيع بحسب طول النص ممنوع، ولا مُحاذِي كلمات متاح بلا ASR
                "startSec": None, "endSec": None, "alignmentConfidence": None,
                "timingSource": "none", "status": "not-measured",
            })
    for vi in range(len(lines) // 2):
        verses.append({"id": f"v{vi + 1:02d}", "index": vi,
                       "hemistichIds": [f"h{2 * vi + 1:03d}", f"h{2 * vi + 2:03d}"]})
    return verses, hemis, words
