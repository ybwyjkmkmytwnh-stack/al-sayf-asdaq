"""مسار شطر واحد كاملًا عبر dist/karaoke_standalone.html (file://) بميكروفون وهمي يمرّ بنفس مسار الالتقاط الحقيقي.
الشروط (تُطبع في التقرير): الصوت الوهمي = مقطع بشري من التسجيل المرجعي نفسه (أو نغمة/صمت)؛ محرّك التعرّف **مُحاكى** بنص يُحقن لكل حالة.
هذا يختبر المنطق (المقارنة، الحواجز، احتساب القراءة، الواجهة) لا دقة Google الفعلية."""
import asyncio, json, subprocess, sys, wave, tempfile
from pathlib import Path
import numpy as np
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / "dist" / "karaoke_standalone.html"; MP3 = ROOT / "web/audio/reference.mp3"
SR = 48000
MOCK = """(() => {
  class FakeRec { constructor(){ this.running=false; }
    start(){ const sc = window.__sttScript || {}; this.running=true; this.t=[];
      setTimeout(()=>{ this.onstart&&this.onstart(); this.onaudiostart&&this.onaudiostart(); }, 20);
      if (sc.error) { this.t.push(setTimeout(()=>{ this.onerror&&this.onerror({error:sc.error}); this._end(); }, sc.at||300)); return; }
      if (sc.text) {
        this.t.push(setTimeout(()=>{ this._res(sc.text.split(' ').slice(0,2).join(' '), false); }, sc.at||600));
        this.t.push(setTimeout(()=>{ this._res(sc.text, true, sc.conf); }, (sc.at||600)+(sc.finalAfter||2200)));
      } }
    _res(text, fin, conf){ const alt = {transcript:text, confidence: conf==null?0.9:conf}; const r=[alt]; r.isFinal=fin; r.item=i=>r[i];
      if(!this.results) this.results=[]; if(fin) this.results.push(r);
      this.onresult && this.onresult({ resultIndex: fin ? this.results.length-1 : this.results.length, results: fin ? this.results : [...this.results, r] }); }
    _end(){ if(!this.running) return; this.running=false; this.t.forEach(clearTimeout); this.onend&&this.onend(); }
    stop(){ setTimeout(()=>this._end(), 80); } abort(){ this._end(); } }
  window.webkitSpeechRecognition = FakeRec; window.SpeechRecognition = FakeRec;
})();"""

def write(path, x):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
def seg(ss, dur, tmp):
    p = tmp / f"s{ss}.wav"
    subprocess.run(["ffmpeg","-y","-v","error","-ss",str(ss),"-t",str(dur),"-i",str(MP3),"-ac","1","-ar",str(SR),"-c:a","pcm_s16le",str(p)], check=True)
    with wave.open(str(p),"rb") as w: return np.frombuffer(w.readframes(w.getnframes()),dtype="<i2").astype(np.float64)/32768

async def run_case(p, name, wav, script, headphones=True, expect=None):
    b = await p.chromium.launch(headless=True, args=["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",f"--use-file-for-fake-audio-capture={wav}","--autoplay-policy=no-user-gesture-required"])
    pg = await b.new_page(viewport={"width": 1100, "height": 900}); errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    await pg.add_init_script(MOCK); await pg.add_init_script(f"window.__sttScript = {json.dumps(script, ensure_ascii=False)};")
    await pg.goto(F.as_uri())
    for _ in range(300):
        st = await pg.evaluate("() => window.__karaokeBoot && window.__karaokeBoot.state")
        if st == "ready": break
        await asyncio.sleep(0.2)
    await pg.evaluate("""async (hp) => { const a = window.__karaoke.app; a.prefs.sttConsent = true; a.prefs.sttOn = true; a.prefs.countdown = 0; a.prefs.headphones = hp; a.setIdx(0);
      await a.ensureEngine(); await a.engine.enableMic({headphones: hp}); a.engine.settings.headphones = hp; a.go('practice'); }""", headphones)
    await asyncio.sleep(0.8)
    lv = await pg.evaluate("() => { const e = window.__karaoke.app.engine; return e.input ? {db: e.input.db, chunks: e.input.chunks} : null }")
    await pg.click("#btn-sing")
    out = None
    for _ in range(120):
        await asyncio.sleep(0.25)
        out = await pg.evaluate("""() => { const q = (s) => document.querySelector(s); const r = q('#speech-result');
          return r ? { chip: q('#read-chip')?.textContent, note: q('#speech-note')?.textContent, heard: q('#heard-txt')?.textContent, score: q('.bigscore')?.textContent, pitchInd: q('.indicators') ? [...document.querySelectorAll('.ind .txt')].map(x=>x.textContent) : null, words: [...document.querySelectorAll('#words-cmp .w')].map(w=>w.dataset.status+':'+w.textContent) } : null }""")
        if out: break
    await b.close()
    return {"name": name, "level_before_play": lv, "result": out, "pageerrors": errs}

async def main():
    tmp = Path(tempfile.mkdtemp())
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True); pg = await b.new_page(); await pg.goto(F.as_uri())
        for _ in range(300):
            if await pg.evaluate("() => window.__karaokeBoot && window.__karaokeBoot.state") == "ready": break
            await asyncio.sleep(0.2)
        hem = await pg.evaluate("() => { const h = window.__karaoke.app.hems[0]; return {s:h.startSec, e:h.endSec, t:h.text}; }"); await b.close()
        print("hemistich 0:", hem["t"], hem["s"], hem["e"])
        s0 = max(0, hem["s"] - 0.8); clip = seg(s0, hem["e"] - s0 + 1.0, tmp)
        quiet = lambda sec: 0.0008*np.random.default_rng(3).standard_normal(int(SR*sec))
        # التسجيل الوهمي يُكرَّر حلقيًّا؛ نبدأه بصمت قصير ثم الشطر البشري
        human = np.concatenate([quiet(0.6), clip, quiet(3)]); write(tmp/"human.wav", human)
        t = np.arange(int(SR*14))/SR; tone = sum(np.sin(2*np.pi*200*k*t)/k for k in range(1,6)); tone = 0.1*tone/np.sqrt(np.mean(tone**2)); write(tmp/"hum.wav", tone)
        write(tmp/"silence.wav", quiet(14))
        exp = hem["t"]; words = exp.split()
        wrong = ' '.join(['قولا' if 'نباء' in w or 'نْبَاء' in w else w for w in words]) if any('نباء' in w or 'نْبَاء' in w for w in words) else ' '.join(words[:-1] + ['قولا'])
        norm = lambda s: ''.join(c for c in s if not ('ً' <= c <= 'ٟ' or c in 'ٰـ'))
        cases = [
          ("1 شطر صحيح (صوت بشري + نص مطابق)", tmp/"human.wav", {"text": norm(exp)}, True),
          ("2 كلمة مبدّلة (صوت بشري + نص فيه «قولا»)", tmp/"human.wav", {"text": norm(wrong), "conf": 0.9}, True),
          ("3 دندنة (نغمة + لا كلام مفهوم)", tmp/"hum.wav", {"text": "لا لا"}, True),
          ("4 صمت (لا صوت + خدمة لا تسمع شيئًا)", tmp/"silence.wav", {}, True),
          ("5 التسجيل المرجعي يُسمع والمستخدم صامت (مكبّرات) والخدمة «سمعت» نص الشطر", tmp/"silence.wav", {"text": norm(exp)}, False),
          ("6 تعطّل الخدمة (network) — الاستماع والنغمة تبقى", tmp/"human.wav", {"error": "network"}, True),
        ]
        res = []
        for name, wav, sc, hp in cases:
            r = await run_case(p, name, wav, sc, headphones=hp); res.append(r); print(json.dumps(r, ensure_ascii=False, indent=1))
    Path(ROOT/"tests/e2e/results/speech_flow.json").write_text(json.dumps({"hem": hem, "cases": res}, ensure_ascii=False, indent=1))
asyncio.run(main())
