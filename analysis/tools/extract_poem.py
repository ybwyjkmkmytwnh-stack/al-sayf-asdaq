#!/usr/bin/env python3
"""يستخرج POEM_LINES حرفيًا من ملف HTML الأصلي إلى web/data/poem.json (خطوة تُنفَّذ مرة واحدة).

الاستخدام:
    python analysis/tools/extract_poem.py <original.html> web/data/poem.json
لا يُعدَّل أي حرف من النص؛ يُحسب فقط textHash = SHA-256 لنص الأشطار مفصولة بـ \\n.
"""
import hashlib, json, re, sys
from pathlib import Path

src = Path(sys.argv[1]).read_text(encoding="utf-8")
m = re.search(r"const\s+POEM_LINES\s*=\s*\[(.*?)\];", src, re.S)
if not m:
    sys.exit("لم يُعثر على POEM_LINES")
lines = json.loads("[" + m.group(1) + "]")
assert all(isinstance(s, str) and s.strip() for s in lines)
assert len(lines) % 2 == 0, "عدد الأشطار فردي"
text = "\n".join(lines)
doc = {
    "schemaVersion": "1.0.0",
    "title": "السيف أصدق إنباءً من الكتب",
    "poet": "أبو تمام",
    "source": "POEM_LINES كما وردت حرفيًا في التطبيق الأصلي (بلا أي تعديل)",
    "hemistichCount": len(lines),
    "verseCount": len(lines) // 2,
    "textHash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    "lines": lines,
}
out = Path(sys.argv[2]); out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print("أشطار:", len(lines), "أبيات:", len(lines) // 2, "hash:", doc["textHash"])
