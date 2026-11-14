#!/usr/bin/env python3
"""خادم ثابت محلي للموقع: Range (للتشغيل/التقديم) + gzip + ترويسات صحيحة + فحص صحة، بمكتبة بايثون القياسية فقط.

    python3 serve.py                # http://localhost:8000
    python3 serve.py --port 8080 --host 127.0.0.1
    python3 serve.py --check        # يتحقق من أن تحليل المرجع يطابق الصوت والنص ثم يخرج (رمز 0/1)

الميكروفون يتطلب «سياقًا آمنًا»: localhost يكفي. على شبكة محلية (http://192.168.x.x) سيرفض المتصفح الميكروفون؛
استعمل HTTPS (--cert/--key) أو نفقًا موثوقًا. الاستماع فقط يعمل في كل الأحوال.
عند الإقلاع يتحقق الخادم من أن reference_analysis.json يطابق الصوت والنص (بصمات SHA-256) ويعيد توليده تلقائيًا إن لم يطابق (--no-auto-analyze لتعطيله).
"""
from __future__ import annotations

import argparse
import gzip
import http.server
import io
import json
import mimetypes
import os
import re
import socketserver
import ssl
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
sys.path.insert(0, str(ROOT / "analysis"))

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("audio/mpeg", ".mp3")
mimetypes.add_type("application/json", ".json")
GZIP_TYPES = {".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt"}
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")


def ensure_analysis(auto: bool = True, log=print) -> bool:
    """يتحقق من مطابقة التحليل للصوت/النص (بصمات SHA-256 + الإصدار + الإعدادات)؛ يعيد التوليد عند عدم المطابقة إن auto."""
    try:
        from refkit.audio_io import sha256_file
        from refkit.pipeline import DEFAULT_SETTINGS, cache_is_valid, run, settings_hash
        from refkit.poem import load_poem
    except Exception as e:  # numpy/scipy غير مثبّتة
        log(f"[تحذير] تعذّر استيراد أداة التحليل ({e}); لن يُتحقَّق من التحليل على الخادم (المتصفح يتحقق على أي حال).")
        return True
    audio, poem, out = WEB / "audio" / "reference.mp3", WEB / "data" / "poem.json", WEB / "data" / "reference_analysis.json"
    try:
        ok, why = cache_is_valid(out, sha256_file(audio), load_poem(poem)["textHash"], settings_hash(DEFAULT_SETTINGS))
    except Exception as e:  # noqa: BLE001
        ok, why = False, f"تعذّر الفحص: {e}"
    if ok:
        log("[تحليل] ملف التحليل يطابق الصوت والنص ✓")
        return True
    log(f"[تحليل] {why}")
    if not auto:
        log("[تحليل] المتصفح سيرفض بدء التدريب. شغّل: python3 analysis/analyze_reference.py --force")
        return False
    log("[تحليل] يُعاد توليد ملف التحليل الآن (≈ 20–60 ثانية)…")
    run(str(audio), str(poem), str(out), force=True, log=lambda m: log("  " + m))
    return True


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "KaraokeStatic/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if self.server.verbose:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _resolve(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        path = os.path.normpath(os.path.join("/", path.lstrip("/"))).lstrip("/\\")
        if path in ("", "."):
            path = "index.html"
        full = (WEB / path).resolve()
        if WEB.resolve() not in full.parents and full != WEB.resolve():
            return None
        if full.is_dir():
            full = full / "index.html"
        return full if full.is_file() else None

    def _send_head(self, status, headers):
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()

    def do_HEAD(self):
        self._serve(head=True)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/health":
            body = json.dumps({"ok": True, "service": "karaoke-static", "analysisOk": self.server.analysis_ok}).encode()
            self._send_head(200, {"Content-Type": "application/json", "Content-Length": str(len(body)), "Cache-Control": "no-store"})
            self.wfile.write(body)
            return
        self._serve(head=False)

    def _serve(self, head: bool):
        f = self._resolve()
        if f is None:
            body = "غير موجود".encode()
            self._send_head(404, {"Content-Type": "text/plain; charset=utf-8", "Content-Length": str(len(body))})
            if not head:
                self.wfile.write(body)
            return
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        size = f.stat().st_size
        base = {"Content-Type": ctype, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"}
        rng = self.headers.get("Range")
        if rng:
            m = RANGE_RE.match(rng.strip())
            if not m or (m.group(1) == "" and m.group(2) == ""):
                self._send_head(416, {**base, "Content-Range": f"bytes */{size}", "Content-Length": "0"})
                return
            if m.group(1) == "":
                n = int(m.group(2)); start, end = max(0, size - n), size - 1
            else:
                start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
            end = min(end, size - 1)
            if start > end or start >= size:
                self._send_head(416, {**base, "Content-Range": f"bytes */{size}", "Content-Length": "0"})
                return
            length = end - start + 1
            self._send_head(206, {**base, "Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(length)})
            if not head:
                with open(f, "rb") as fh:
                    fh.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = fh.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            return
        if f.suffix in GZIP_TYPES and "gzip" in (self.headers.get("Accept-Encoding") or "") and size > 1024:
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6, mtime=0) as gz:
                gz.write(f.read_bytes())
            data = buf.getvalue()
            self._send_head(200, {**base, "Content-Encoding": "gzip", "Vary": "Accept-Encoding", "Content-Length": str(len(data))})
            if not head:
                self.wfile.write(data)
            return
        self._send_head(200, {**base, "Content-Length": str(size)})
        if not head:
            with open(f, "rb") as fh:
                while True:
                    chunk = fh.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="خادم الموقع المحلي")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--cert"); ap.add_argument("--key")
    ap.add_argument("--check", action="store_true", help="تحقق من مطابقة التحليل ثم اخرج")
    ap.add_argument("--no-auto-analyze", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args(argv)
    ok = ensure_analysis(auto=not a.no_auto_analyze and not a.check)
    if a.check:
        return 0 if ok else 1
    srv = Server((a.host, a.port), Handler)
    srv.verbose = a.verbose
    srv.analysis_ok = ok
    scheme = "http"
    if a.cert and a.key:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(a.cert, a.key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        scheme = "https"
    host = "localhost" if a.host in ("127.0.0.1", "0.0.0.0", "::") else a.host
    print(f"\nالموقع جاهز: {scheme}://{host}:{a.port}/   (Ctrl+C للإيقاف)")
    if a.host not in ("127.0.0.1", "localhost") and scheme == "http":
        print("تنبيه: الميكروفون لن يعمل من عنوان شبكة غير آمن (http). افتح الموقع من localhost أو استعمل --cert/--key.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nأُوقف الخادم.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
