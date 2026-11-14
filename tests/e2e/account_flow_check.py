"""مسار الحساب: تسجيل متدرّب ← محاولة ← ظهورها في «تدريباتي» من جلسة متصفح جديدة؛ وعزل حساب ثانٍ؛ وفشل الشبكة بلا تكرار.
خادم Supabase هنا **وهمي محلي** يحاكي GoTrue/PostgREST (يفرض user_id وقيد التفرّد). يثبت منطق الواجهة والعميل لا سياسات RLS الحقيقية."""
import asyncio, json, threading, uuid, wave, tempfile, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import numpy as np
from playwright.async_api import async_playwright
sys.path.insert(0, str(Path(__file__).parent))
ROOT = Path(__file__).resolve().parents[2]; F = ROOT/"dist"/"karaoke_standalone.html"; SR = 48000
USERS = {}; ATT = []; STATE = {"fail": 0}
def tok(uid): return f"tok-{uid}"
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _cors(self): self.send_header("Access-Control-Allow-Origin","*"); self.send_header("Access-Control-Allow-Headers","*"); self.send_header("Access-Control-Allow-Methods","*")
    def _send(self, code, obj=None):
        b = json.dumps(obj).encode() if obj is not None else b""
        self.send_response(code); self._cors(); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_OPTIONS(self): self.send_response(204); self._cors(); self.end_headers()
    def _body(self): n=int(self.headers.get("Content-Length") or 0); return json.loads(self.rfile.read(n) or b"{}")
    def _uid(self):
        a = self.headers.get("Authorization","").replace("Bearer ","")
        return a[4:] if a.startswith("tok-") else None
    def do_POST(self):
        p = self.path; b = self._body()
        if p.startswith("/auth/v1/signup"):
            uid = str(uuid.uuid4()); USERS[b["email"]] = {"id": uid, "pw": b["password"]}
            return self._send(200, {"access_token": tok(uid), "refresh_token": "r", "user": {"id": uid, "email": b["email"]}})
        if p.startswith("/auth/v1/token"):
            u = USERS.get(b.get("email"))
            if not u or u["pw"] != b.get("password"): return self._send(400, {"error_description": "Invalid login credentials"})
            return self._send(200, {"access_token": tok(u["id"]), "refresh_token": "r", "user": {"id": u["id"], "email": b["email"]}})
        if p.startswith("/rest/v1/attempts"):
            uid = self._uid()
            if not uid: return self._send(401, {"message": "jwt"})
            if STATE["fail"] > 0: STATE["fail"] -= 1; return self._send(503, {"message": "down"})
            if b.get("user_id") != uid: return self._send(403, {"message": "RLS"})       # يحاكي with check
            if not any(a["user_id"]==uid and a["client_attempt_id"]==b["client_attempt_id"] for a in ATT): ATT.append(b)
            return self._send(201)
        self._send(404, {})
    def do_GET(self):
        if self.path.startswith("/rest/v1/attempts"):
            uid = self._uid()
            if not uid: return self._send(401, {"message":"jwt"})
            return self._send(200, sorted([a for a in ATT if a["user_id"]==uid], key=lambda a:a.get("created_at",""), reverse=True)[::-1])   # يحاكي using (user_id = auth.uid())
        self._send(404, {})
srv = ThreadingHTTPServer(("127.0.0.1", 0), H); PORT = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()

STT = """(() => { class R { start(){ this.run=true; this.t=[]; setTimeout(()=>this.onstart&&this.onstart(),20);
  this.t.push(setTimeout(()=>{ const r=[{transcript:window.__txt,confidence:.9}]; r.isFinal=true; this.res=[r]; this.onresult&&this.onresult({resultIndex:0,results:this.res}); },1500)); }
  stop(){ setTimeout(()=>{ if(this.run){this.run=false; this.onend&&this.onend();} },80);} abort(){ this.run=false; this.t.forEach(clearTimeout);} }
  window.webkitSpeechRecognition=R; window.SpeechRecognition=R; })();"""
async def boot(p, wav, txt=None):
    b = await p.chromium.launch(headless=True, args=["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",f"--use-file-for-fake-audio-capture={wav}","--autoplay-policy=no-user-gesture-required"])
    pg = await b.new_page(viewport={"width":1100,"height":900}); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    await pg.add_init_script(STT); await pg.add_init_script(f"window.__txt={json.dumps(txt or '',ensure_ascii=False)};")
    await pg.goto(F.as_uri())
    for _ in range(300):
        if await pg.evaluate("()=>window.__karaokeBoot&&window.__karaokeBoot.state")=="ready": break
        await asyncio.sleep(0.2)
    await pg.evaluate(f"()=>{{const c=window.__karaoke.app.cloud; c.url='http://127.0.0.1:{PORT}'; c.anonKey='anon'; c.store=new Map(); c.session=null; c.pending=[];}}")
    return b, pg, errs
async def acct(pg, email, pw, signup=False):
    await pg.evaluate("()=>window.__karaoke.app.go('account')"); await pg.fill("#acc-email", email); await pg.fill("#acc-pass", pw)
    await pg.click("#btn-signup" if signup else "#btn-login")
    await pg.wait_for_selector("#btn-logout", timeout=8000)
async def main():
    tmp = Path(tempfile.mkdtemp()); wav = tmp/"v.wav"
    t = np.arange(int(SR*10))/SR; x = 0.1*np.sin(2*np.pi*200*t)*(1+0.5*np.sin(2*np.pi*3*t))
    with wave.open(str(wav),"wb") as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((x*32767).astype("<i2").tobytes())
    out = {}
    async with async_playwright() as p:
        b1, pg1, e1 = await boot(p, wav, txt="السيف اصدق قولا من الكتب")
        await acct(pg1, "trainee1@example.com", "password1", signup=True)
        await pg1.evaluate("async()=>{const a=window.__karaoke.app;a.prefs.countdown=0;a.prefs.headphones=true;a.prefs.sttConsent=true;a.prefs.sttOn=true;a.setIdx(0);await a.ensureEngine();await a.engine.enableMic({headphones:true});a.go('practice');}")
        await asyncio.sleep(0.8); await pg1.click("#btn-sing")
        for _ in range(100):
            await asyncio.sleep(0.3)
            st = await pg1.evaluate("()=>document.getElementById('save-status')?.textContent||''")
            if st: break
        out["status_after_attempt"] = st; out["server_rows_after_attempt"] = len(ATT)
        # فشل شبكة: المحاولة الثانية تُعلَّق ثم تُرسل مرة واحدة
        STATE["fail"] = 1
        await pg1.evaluate("()=>window.__karaoke.app.go('practice')"); await asyncio.sleep(0.5)
        await pg1.evaluate("async()=>{const a=window.__karaoke.app; const r=await a.persistAttempt(a.hems[0],{overall:0.5},null,'line'); window.__st2=r;}")
        out["status_when_server_down"] = await pg1.evaluate("()=>window.__st2"); out["pending"] = await pg1.evaluate("()=>window.__karaoke.app.cloud.pending.length")
        await pg1.evaluate("()=>window.__karaoke.app.go('account')"); await asyncio.sleep(1.5)
        out["rows_after_flush"] = len(ATT); out["pending_after_flush"] = await pg1.evaluate("()=>window.__karaoke.app.cloud.pending.length")
        await b1.close()
        # جلسة متصفح جديدة تمامًا: نفس الحساب
        b2, pg2, e2 = await boot(p, wav)
        await acct(pg2, "trainee1@example.com", "password1"); await asyncio.sleep(1.0)
        out["new_browser_count_text"] = await pg2.evaluate("()=>document.getElementById('mine-count')?.textContent"); out["new_browser_last"] = await pg2.evaluate("()=>document.getElementById('mine-last')?.textContent")
        out["new_browser_words"] = await pg2.evaluate("()=>[...document.querySelectorAll('#mine-words li')].map(l=>l.textContent)")
        await b2.close()
        # حساب ثانٍ لا يرى شيئًا
        USERS["trainee2@example.com"] = {"id": str(uuid.uuid4()), "pw": "password2"}
        b3, pg3, e3 = await boot(p, wav); await acct(pg3, "trainee2@example.com", "password2"); await asyncio.sleep(1.0)
        out["second_user_view"] = await pg3.evaluate("()=>document.getElementById('mine')?.textContent"); await b3.close()
    out["pageerrors"] = e1+e2+e3
    Path(ROOT/"tests/e2e/results/account_flow.json").write_text(json.dumps(out, ensure_ascii=False, indent=1)); print(json.dumps(out, ensure_ascii=False, indent=1))
asyncio.run(main())
