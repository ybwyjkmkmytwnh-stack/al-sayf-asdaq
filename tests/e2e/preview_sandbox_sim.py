"""محاكاة تقريبية لقيود صفحة المعاينة المنشورة: iframe من أصل مختلف بلا allow=microphone + CSP وفق قواعد النشر.
ليست المنصة نفسها. التشغيل: python3 -I tests/e2e/preview_sandbox_sim.py (تُحفظ اللقطات في tests/e2e/results/sim_*.png)."""
import asyncio, http.server, os, re, socketserver, sys, threading
from pathlib import Path
from playwright.async_api import async_playwright

WEB = Path(__file__).resolve().parents[2] / "web"
OUT = Path(__file__).resolve().parent / "results"; OUT.mkdir(exist_ok=True)
CSP = ("default-src 'none'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; "
       "media-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; "
       "connect-src 'self'; worker-src 'self' blob:")
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".json": "application/json", ".mp3": "audio/mpeg"}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        p = self.path.split("?", 1)[0]
        if p == "/":
            p = "/index.html"
        f = (WEB / p.lstrip("/")).resolve()
        if WEB not in f.parents or not f.is_file():
            self.send_response(404); self.end_headers(); return
        data = f.read_bytes()
        status, start, end = 200, 0, len(data) - 1
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                a, b = m.groups()
                start = int(a) if a else 0
                end = int(b) if b else len(data) - 1
                status = 206
        body = data[start:end + 1]
        self.send_response(status)
        self.send_header("Content-Type", MIME.get(f.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
        if f.suffix == ".html":
            self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        self.wfile.write(body)


class TS(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


class W(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = WRAP.encode()
        self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)


WRAP = ""


def serve(port, handler=H):
    s = TS(("127.0.0.1", port), handler)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


async def main():
    global WRAP
    s_app = serve(8811)
    s_wrap = serve(8812, W)
    WRAP = '<!doctype html><meta charset=utf-8><body style="margin:0"><iframe id=f src="http://127.0.0.1:8811/index.html" ' \
           'sandbox="allow-scripts allow-same-origin" style="border:0;width:390px;height:844px"></iframe>'
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
        ctx = await b.new_context(viewport={"width": 390, "height": 844})
        page = await ctx.new_page()
        logs = []
        page.on("console", lambda m: logs.append((m.type, m.text[:300])))
        page.on("pageerror", lambda e: logs.append(("pageerror", str(e)[:300])))
        import urllib.request
        print("direct fetch:", urllib.request.urlopen("http://127.0.0.1:8811/index.html", timeout=5).status)
        await page.goto("http://127.0.0.1:8812/")
        fr = None
        for _ in range(100):
            fr = next((f for f in page.frames if "8811" in f.url), None)
            if fr:
                break
            await asyncio.sleep(0.1)
        print("frame url:", fr.url if fr else None, "| all frames:", [f.url for f in page.frames], "| page:", page.url)
        print("early logs:", logs[:6])
        try:
            for _ in range(300):
                st = await fr.evaluate("() => window.__karaokeBoot && window.__karaokeBoot.state")
                if st and st != 'loading':
                    break
                await asyncio.sleep(0.2)
            print("boot state:", st)
        except Exception as e:
            print("BOOT FAILED:", str(e)[:200])
        await page.screenshot(path=str(OUT / "sim_01_home.png"))
        txt = await fr.evaluate("document.body.innerText.slice(0,300)")
        print("home text:", txt.replace("\n", " | ")[:300])
        # الضغط على «ابدأ التدريب»
        try:
            await fr.get_by_text("ابدأ التدريب").first.click(timeout=5000)
            await asyncio.sleep(1.0)
            print("after start:", (await fr.evaluate("document.body.innerText.slice(0,400)")).replace("\n", " | ")[:400])
            await page.screenshot(path=str(OUT / "sim_02_after_start.png"))
        except Exception as e:
            print("click failed:", str(e)[:200])
        # محاولة الميكروفون مباشرة داخل الإطار
        res = await fr.evaluate("""async()=>{try{const s=await navigator.mediaDevices.getUserMedia({audio:true});s.getTracks().forEach(t=>t.stop());return 'granted'}catch(e){return e.name+': '+e.message}}""")
        print("getUserMedia inside cross-origin iframe (no allow=microphone):", res)
        # Worker + AudioWorklet ضمن CSP
        res2 = await fr.evaluate("""async()=>{const out={};try{const w=new Worker('js/audio/pitch-worker.js',{type:'module'});out.worker='created';w.terminate()}catch(e){out.worker=e.name+': '+e.message}
          try{const c=new AudioContext();await c.audioWorklet.addModule('js/audio/capture-worklet.js');out.worklet='ok sr='+c.sampleRate;c.close()}catch(e){out.worklet=e.name+': '+e.message}
          return JSON.stringify(out)}""")
        print("worker/worklet:", res2)
        # استماع فقط: تشغيل فعلي بعد نقرة
        await fr.evaluate("() => window.__karaoke.app.go('listen')")
        await asyncio.sleep(0.8)
        await fr.locator('button[aria-label="تشغيل"]').first.click(timeout=5000)
        rd = "() => { const e=[...document.querySelectorAll('.num.muted')].find(x=>/:/.test(x.textContent)); return e? e.textContent : null }"
        await asyncio.sleep(1.2)
        t1 = await fr.evaluate(rd)
        await asyncio.sleep(3.0)
        t2 = await fr.evaluate(rd)
        paused = await fr.evaluate("() => !!document.querySelector('button[aria-label=\"تشغيل\"]')")
        dur = 0.0
        print(f"listen-only playback in sandbox sim: time shown t1={t1} -> t2={t2}; play-button-shown(=paused)={paused}")
        await page.screenshot(path=str(OUT / "sim_03_listen.png"))
        errs = [l for l in logs if l[0] in ("error", "pageerror")]
        print("console errors:", errs[:8])
        await b.close()
    s_app.shutdown()


asyncio.run(main())
