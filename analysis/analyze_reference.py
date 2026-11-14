#!/usr/bin/env python3
"""تشغيل خط التحليل المرجعي.

مثال:
    python analysis/analyze_reference.py                    # المسارات الافتراضية للمشروع
    python analysis/analyze_reference.py --force            # إعادة التحليل دون النظر للتخزين المؤقت
    python analysis/analyze_reference.py --check            # تحقق فقط: هل ملف التحليل مطابق للصوت/النص الحاليين؟

يرفض/يعيد توليد التحليل تلقائيًا إذا اختلفت بصمة الصوت أو النص أو الإصدار أو الإعدادات.
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from refkit.audio_io import sha256_file  # noqa: E402
from refkit.pipeline import DEFAULT_SETTINGS, cache_is_valid, run, settings_hash  # noqa: E402
from refkit.poem import load_poem  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--audio", default=str(ROOT / "web/audio/reference.mp3"))
    ap.add_argument("--poem", default=str(ROOT / "web/data/poem.json"))
    ap.add_argument("--out", default=str(ROOT / "web/data/reference_analysis.json"))
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    if a.check:
        ok, why = cache_is_valid(Path(a.out), sha256_file(a.audio), load_poem(a.poem)["textHash"],
                                 settings_hash(DEFAULT_SETTINGS))
        print(("صالح: " if ok else "غير صالح: ") + why)
        sys.exit(0 if ok else 2)
    _, fresh = run(a.audio, a.poem, a.out, force=a.force)
    print("تم توليد تحليل جديد." if fresh else "لا حاجة لإعادة التحليل (التخزين المؤقت صالح).")


if __name__ == "__main__":
    main()
