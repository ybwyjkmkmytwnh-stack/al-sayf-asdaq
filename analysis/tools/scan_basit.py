#!/usr/bin/env python3
"""تقطيع عروضي آلي (قائم على قواعد) لقصيدة على بحر البسيط → web/data/prosody.json.
الرمز: 1 = متحرك ، 0 = ساكن. غير مراجَع بشريًا؛ ما لا يطابق أي تفعيلة مسموحة يُوسَم 'unmatched'."""
import json, re, sys, unicodedata
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
FATHA, DAMMA, KASRA, SUKUN, SHADDA = "َ", "ُ", "ِ", "ْ", "ّ"
TANW = {"ً", "ٌ", "ٍ"}
VOW = {FATHA, DAMMA, KASRA}
MARKS = VOW | TANW | {SUKUN, SHADDA, "ٰ"}
WASL = {"ا", "ٱ"}
MADD = {"ا", "و", "ي", "ى"}

FEET = {  # التفعيلات المسموحة في البسيط (التامّ) ورموزها
    "mus": {"1010110": "مُسْتَفْعِلُنْ", "110110": "مُتَفْعِلُنْ", "101110": "مُسْتَعِلُنْ", "11110": "مُتَعِلُنْ"},
    "fa": {"10110": "فَاعِلُنْ", "1110": "فَعِلُنْ"},
    "last": {"1110": "فَعِلُنْ", "10110": "فَاعِلُنْ", "1010": "فَعْلُنْ", "110": "فَعْلُ"},
}
SEQ = ["mus", "fa", "mus", "last"]


def tokens(word):
    out = []
    for ch in word:
        if ch in MARKS and out:
            out[-1]["m"].add(ch)
        elif ch == "ـ":
            continue
        else:
            out.append({"c": ch, "m": set()})
    return out


def scan_verse(h1, h2, lengthen_mid):
    words = [(0, w) for w in h1.split()] + [(1, w) for w in h2.split()]
    toks = [tokens(w) for _, w in words]
    units = []  # (unit, wordIdx, charIdx)
    issues = []
    nw = len(words)
    for wi, tk in enumerate(toks):
        prev_unit_idx_word = None
        starts_wasl = bool(tk) and tk[0]["c"] in WASL and not tk[0]["m"]
        nx = toks[wi + 1] if wi + 1 < nw else []
        nxt_wasl = len(nx) > 2 and nx[0]["c"] in WASL and not nx[0]["m"] and (nx[1]["c"] == "ل" or SUKUN in nx[1]["m"])
        j = 0
        word_units = []
        # موضع ألف «ال» (a) : 0 مباشرة، أو 1 بعد سابقة (و/ف/ب/ك/ل) متحركة
        art = None
        if len(tk) > 2 and tk[0]["c"] in WASL and not tk[0]["m"] and tk[1]["c"] == "ل":
            art = 0
        elif len(tk) > 3 and tk[0]["c"] in "وفبكل" and (tk[0]["m"] & VOW) and tk[1]["c"] in WASL and not tk[1]["m"] and SUKUN in tk[2]["m"]:
            art = -3   # كَاسْمِ: ألف الوصل بعد سابقة
        elif len(tk) > 2 and tk[0]["c"] == "ل" and KASRA in tk[0]["m"] and tk[1]["c"] == "ل" and not tk[1]["m"]:
            art = -2   # لِلـ = لِـ + الـ بلا ألف مكتوبة
        elif len(tk) > 1 and tk[0]["c"] in WASL and not tk[0]["m"] and tk[1]["c"] != "ل":
            art = -1   # فعل/اسم بهمزة وصل (انصرف، افترع)
        elif len(tk) > 3 and tk[0]["c"] in "وفبكل" and (tk[0]["m"] & VOW) and tk[1]["c"] in WASL and not tk[1]["m"] and tk[2]["c"] == "ل":
            art = 1
        # حرف قبل ألف التنوين يأخذ الفتحة ضمنًا
        for k in range(1, len(tk)):
            if tk[k]["c"] in ("ا", "ى") and (tk[k]["m"] & TANW) and not (tk[k - 1]["m"] & (VOW | TANW | {SUKUN})):
                tk[k - 1]["m"].add(FATHA)
        for ci, t in enumerate(tk):
            c, m = t["c"], t["m"]
            vow = next((v for v in VOW if v in m), None)
            tan = bool(m & TANW)
            if art == -3 and ci == 1:
                continue
            if art == -2 and ci == 1:
                if SHADDA in tk[2]["m"]:
                    continue
                word_units.append((0, ci)); continue
            if art == -1 and ci == 0:
                if wi == 0:
                    word_units.append((1, ci))
                continue
            if art is not None and art >= 0 and ci == art:
                if wi == 0 and art == 0:
                    word_units.append((1, ci))     # بداية البيت: همزة قطع ملفوظة
                continue                            # وصل: تُحذف
            if art is not None and art >= 0 and ci == art + 1:
                if len(tk) > ci + 1 and SHADDA in tk[ci + 1]["m"]:
                    continue                        # لام شمسية تُدغم
                word_units.append((0, ci)); continue  # لام قمرية ساكنة
            if c == "ا" and not m and ci == len(tk) - 1 and ci > 0 and tk[ci - 1]["c"] == "و":
                continue                            # ألف واو الجماعة
            if c in ("ا", "ى") and (m & TANW):
                word_units.append((0, ci)); continue  # ألف التنوين: تُنطق نونًا ساكنة
            if c in ("ا", "ى") and not m and ci > 0 and (tk[ci - 1]["m"] & TANW):
                continue                            # ألف/ياء بعد حرف عليه تنوين فتح: صامتة
            if c in MADD and not m and ci > 0:
                word_units.append((0, ci)); continue
            if c == "آ":
                word_units.append((1, ci)); word_units.append((0, ci)); continue
            if SHADDA in m:
                word_units.append((0, ci)); word_units.append((1, ci))
                if tan: word_units.append((0, ci))
                continue
            if SUKUN in m:
                word_units.append((0, ci)); continue
            if tan:
                word_units.append((1, ci)); word_units.append((0, ci)); continue
            if vow:
                word_units.append((1, ci))
                if "ٰ" in m:
                    word_units.append((0, ci))
                continue
            issues.append(f"حرف بلا حركة: {c} في «{words[wi][1]}»")
            word_units.append((1, ci))
        # قواعد الوصل مع الكلمة التالية
        if nxt_wasl and word_units:
            last_c = tk[-1]
            if word_units[-1][0] == 0 and tk[-1]["c"] in MADD and not tk[-1]["m"]:
                word_units.pop()                    # حذف حرف المد قبل ساكن
            elif word_units[-1][0] == 0 and SUKUN in tk[-1]["m"]:
                word_units[-1] = (1, word_units[-1][1])   # ساكن + وصل ⇒ يُكسر
            elif word_units[-1][0] == 0 and tk[-1]["m"] & TANW:
                word_units[-1] = (1, word_units[-1][1])   # نون التنوين تُكسر
        # ألف تُنطق وتُحذف في الخط (الله، ذلك، هذا، لكن …)
        plain0 = "".join(k["c"] for k in tk)
        def add_after(letter_idx):
            pos = max(i for i, (u, c_) in enumerate(word_units) if c_ == letter_idx)
            word_units.insert(pos + 1, (0, letter_idx))
        try:
            if plain0.endswith("لله") or plain0.endswith("الله") or plain0.endswith("للە"):
                add_after(len(tk) - 2)
            elif plain0.endswith("ذلك") and len(tk) >= 3:
                add_after(len(tk) - 3)
            elif plain0.endswith("ذلكم") and len(tk) >= 4:
                add_after(len(tk) - 4)
            elif plain0 in ("هذا", "هذه", "هذان", "هذي", "وهذا", "فهذا", "هذين") or plain0.endswith("هذا") or plain0.endswith("هذه"):
                add_after(plain0.index("ه"))
            elif plain0 in ("لكن", "ولكن", "فلكن"):
                add_after(plain0.index("ل"))
            elif plain0 in ("أولئك", "أولئكم", "أولاء"):
                add_after(plain0.index("ل"))
        except ValueError:
            pass
        # ميم الجمع المضمومة بين متحركين تُشبَع
        if len(tk) >= 3 and tk[-1]["c"] == "م" and DAMMA in tk[-1]["m"] and tk[-2]["c"] in "هكت" and not nxt_wasl and wi + 1 < nw:
            nxt_t = toks[wi + 1][0] if toks[wi + 1] else None
            if nxt_t and not (nxt_t["c"] in WASL and not nxt_t["m"]):
                word_units.append((0, len(tk) - 1))
        # إشباع هاء الضمير بين متحركين
        plain = "".join(k["c"] for k in tk)
        if len(tk) >= 2 and tk[-1]["c"] == "ه" and plain.replace("ا", "").replace("ب", "").replace("و", "").replace("ف", "").replace("ل", "") != "" and not plain.endswith("لله") and not plain.endswith("الله") and (DAMMA in tk[-1]["m"] or KASRA in tk[-1]["m"]) \
                and (tk[-2]["m"] & (VOW | {SHADDA})) and not (tk[-2]["m"] & {SUKUN}) \
                and wi + 1 < nw and not nxt_wasl:
            word_units.append((0, len(tk) - 1))
        for u, ci in word_units:
            units.append((u, wi, ci))
    # نهاية الصدر (تصريع/إشباع اختياري)
    n1 = len(h1.split())
    if lengthen_mid:
        idx = max(i for i, u in enumerate(units) if u[1] == n1 - 1)
        if units[idx][0] == 1:
            units.insert(idx + 1, (0, units[idx][1], units[idx][2]))
    # نهاية البيت: إشباع آخر حرف متحرك
    if units and units[-1][0] == 1:
        units.append((0, units[-1][1], units[-1][2]))
    # نهاية الصدر (اختياري)
    n1 = len(h1.split())
    return units, issues, n1


def match(bits, mid_unit_count):
    """مطابقة البيت كله بتفعيلات (٤ للصدر + ٤ للعجز) عبر DP. تُرجع قائمة (مفتاح، صيغة، نص) أو None."""
    seq = SEQ + SEQ
    best = {}
    def rec(pos, k):
        if (pos, k) in best: return best[(pos, k)]
        if k == len(seq):
            r = [] if pos == len(bits) else None
        else:
            r = None
            for pat, name in FEET[seq[k]].items():
                if bits.startswith(pat, pos):
                    sub = rec(pos + len(pat), k + 1)
                    if sub is not None:
                        r = [(seq[k], pat, name)] + sub; break
        best[(pos, k)] = r
        return r
    return rec(0, 0)


def main():
    poem = json.load(open(ROOT / "web/data/poem.json", encoding="utf-8"))
    L = poem["lines"]
    verses = []
    unmatched = []
    for v in range(len(L) // 2):
        h1, h2 = L[2 * v], L[2 * v + 1]
        res = None
        for mid in (False, True):
            units, issues, n1 = scan_verse(h1, h2, mid)
            bits = "".join(str(u[0]) for u in units)
            res = match(bits, 0)
            if res: break
        feet = res
        # تقسيم الوحدات على الشطرين وعلى الكلمات
        hem_units = [[], []]
        pos = 0
        words_all = h1.split() + h2.split()
        per_word = [[] for _ in words_all]
        for u, wi, ci in units: per_word[wi].append(u)
        out = {"verse": v, "bits": bits, "matched": bool(feet), "issues": issues,
               "words": [{"text": w, "pattern": "".join(map(str, pw))} for w, pw in zip(words_all, per_word)],
               "n1": n1}
        if feet:
            out["feet"] = [{"pattern": p, "name": n} for _, p, n in feet]
        else:
            unmatched.append(v)
        verses.append(out)
    doc = {"meter": "البسيط", "meterNote": "مستفعلن فاعلن مستفعلن فعلن (مرّتين). 1 = متحرك، 0 = ساكن.",
           "generator": "analysis/tools/scan_basit.py (قواعد آلية)", "verified": False,
           "warning": "تقطيع آلي غير مراجَع بشريًا؛ قد يخطئ في حالات الوصل والإشباع. الأبيات الموسومة بعدم المطابقة تحتاج مراجعة.",
           "unmatchedVerses": unmatched, "verses": verses}
    json.dump(doc, open(ROOT / "web/data/prosody.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"verses={len(verses)} matched={len(verses)-len(unmatched)} unmatched={unmatched}")
    for v in unmatched[:6]:
        print(v, L[2*v], "|", L[2*v+1]); print("   ", verses[v]["bits"], verses[v]["issues"][:3])


if __name__ == "__main__":
    main()
