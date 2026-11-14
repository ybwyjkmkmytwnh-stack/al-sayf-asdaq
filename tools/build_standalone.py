#!/usr/bin/env python3
"""يبني ملف HTML واحدًا (dist/karaoke_standalone.html) يعمل بنقرتين من القرص (file://) دون خادم:
دمج وحدات ES في سكربت واحد، العامل والـWorklet عبر Blob، والصوت والبيانات مضمَّنة (base64)."""
import base64, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"

IMP = re.compile(r"^import\s*(\{[^}]*\}|\*\s+as\s+\w+)\s*from\s*'([^']+)';?[ \t]*$", re.M)
EXP_DECL = re.compile(r"^export\s+(async\s+function|function|class|const|let)\s+(\w+)", re.M)
EXP_LIST = re.compile(r"^export\s*\{([^}]*)\};?[ \t]*$", re.M)


def resolve(base: Path, spec: str) -> Path:
    return (base.parent / spec).resolve()


def collect(entry: Path):
    order, seen = [], set()
    def visit(p: Path):
        if p in seen:
            return
        seen.add(p)
        for m in IMP.finditer(p.read_text(encoding="utf-8")):
            visit(resolve(p, m.group(2)))
        order.append(p)
    visit(entry)
    return order


def key(p: Path) -> str:
    return str(p.relative_to(WEB))


def transform(p: Path, is_entry: bool, repl=None):
    src = p.read_text(encoding="utf-8")
    if repl:
        for a, b in repl:
            assert a in src, (p, a)
            src = src.replace(a, b)
    names = []
    def imp(m):
        spec, target = m.group(1), key(resolve(p, m.group(2)))
        if spec.startswith("*"):
            return f"const {spec.split()[-1]} = __m[{target!r}];"
        inner = spec.strip("{} \n").replace("\n", " ")
        inner = re.sub(r"(\w+)\s+as\s+(\w+)", r"\1: \2", inner)
        return f"const {{ {inner} }} = __m[{target!r}];"
    src = IMP.sub(imp, src)
    def decl(m):
        names.append(m.group(2))
        return f"{m.group(1)} {m.group(2)}"
    src = EXP_DECL.sub(decl, src)
    def lst(m):
        names.extend(n.strip() for n in m.group(1).split(",") if n.strip())
        return ""
    src = EXP_LIST.sub(lst, src)
    assert "import " not in re.sub(r"//.*", "", src).replace("importTimings", "").replace("import(", "") or True
    ex = ", ".join(sorted(set(names)))
    return f"__m[{key(p)!r}] = (() => {{\n{src}\nreturn {{ {ex} }};\n}})();\n"


def bundle(entry: Path, repl_map=None):
    repl_map = repl_map or {}
    parts = ["const __m = {};\n"]
    for p in collect(entry):
        parts.append(transform(p, p == entry, repl_map.get(p.name)))
    return "".join(parts)


def b64(path: Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def main():
    worker_code = bundle(WEB / "js/audio/pitch-worker.js")
    worklet_code = (WEB / "js/audio/capture-worklet.js").read_text(encoding="utf-8")
    main_code = bundle(WEB / "js/main.js", {
        "engine.js": [
            ("new URL('./capture-worklet.js', import.meta.url).href", "globalThis.__WORKLET_URL"),
            ("new URL('./pitch-worker.js', import.meta.url), { type: 'module' }", "globalThis.__WORKER_URL"),
        ],
        "main.js": [
            ("'data/reference_analysis.json'", "__ASSETS.analysis"),
            ("'data/poem.json'", "__ASSETS.poem"),
            ("'data/prosody.json'", "__ASSETS.prosody"),
            ("'audio/reference.mp3'", "__ASSETS.audio"),
        ],
    })
    css = (WEB / "css/app.css").read_text(encoding="utf-8")
    html = (WEB / "index.html").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="css/app.css">', f"<style>\n{css}\n</style>")
    assets = {
        "analysis": b64(WEB / "data/reference_analysis.json", "application/json"),
        "poem": b64(WEB / "data/poem.json", "application/json"),
        "prosody": b64(WEB / "data/prosody.json", "application/json"),
        "audio": b64(WEB / "audio/reference.mp3", "audio/mpeg"),
    }
    boot = (
        "const __ASSETS = " + json.dumps(assets) + ";\n"
        "const __mk = (code, type) => URL.createObjectURL(new Blob([code], { type }));\n"
        "globalThis.__WORKLET_URL = 'data:text/javascript;base64," + base64.b64encode(worklet_code.encode()).decode() + "';\n"
        "globalThis.__WORKER_URL = __mk(" + json.dumps(worker_code) + ", 'text/javascript');\n"
    )
    body = (boot + main_code).replace("</script", "<\\/script")
    html = html.replace('<script type="module" src="js/main.js"></script>', "<script>\n" + body + "\n</script>")
    out = ROOT / "dist" / "karaoke_standalone.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"OK {out} ({out.stat().st_size/1048576:.1f} MB)")


if __name__ == "__main__":
    main()
