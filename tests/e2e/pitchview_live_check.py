"""يختبر مسار الرسم المباشر: صعود نغمة، ثبات مع زيادة قوة، ثم صمت — بميكروفون وهمي عبر نفس مسار الالتقاط، وسماعات (دون مزامنة δ)."""
import asyncio, json, wave, tempfile
from pathlib import Path
import numpy as np
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parents[2]; F = ROOT/"dist"/"karaoke_standalone.html"; SR=48000
def tone(f, a):  # f array Hz
    ph = 2*np.pi*np.cumsum(f)/SR; return a*sum(np.sin(k*ph)/k for k in (1,2,3))/1.8
def build(path):
    q = lambda s: 0.0005*np.random.default_rng(1).standard_normal(int(SR*s))
    seg=[q(1.5), tone(np.linspace(150,300,int(SR*3)),0.05), tone(np.full(int(SR*2.5),220.0),0.02), tone(np.full(int(SR*2.5),220.0),0.2), q(2.5)]
    x=np.concatenate(seg); x=np.concatenate([x]*3)
    with wave.open(str(path),"wb") as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(x,-1,1)*32767).astype("<i2").tobytes())
async def main():
    tmp=Path(tempfile.mkdtemp()); wav=tmp/"v.wav"; build(wav)
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True,args=["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",f"--use-file-for-fake-audio-capture={wav}","--autoplay-policy=no-user-gesture-required"])
        pg=await b.new_page(viewport={"width":1100,"height":900}); errs=[]; pg.on("pageerror",lambda e:errs.append(str(e)[:200]))
        await pg.goto(F.as_uri())
        for _ in range(300):
            if await pg.evaluate("()=>window.__karaokeBoot&&window.__karaokeBoot.state")=="ready": break
            await asyncio.sleep(0.2)
        await pg.evaluate("""async()=>{const a=window.__karaoke.app;a.prefs.countdown=0;a.prefs.headphones=true;a.setIdx(0);await a.ensureEngine();await a.engine.enableMic({headphones:true});a.go('practice');}""")
        await asyncio.sleep(0.8); await pg.click("#btn-sing")
        samples=[]
        for _ in range(55):
            await asyncio.sleep(0.2)
            s=await pg.evaluate("""()=>{const v=window.__pitchView,e=window.__karaoke.app.engine;const t=e.trail||[];const l=t[t.length-1];return {state:v?.liveInfo?.state,pts:v?.liveInfo?.points,lvl:v?.liveInfo?.level,c:l&&l.voiced?l.c:null,db:l?l.db:null,eng:e.state,trk:e.seg?e.seg.tracker.count:null}}""")
            samples.append(s)
        cv=await pg.evaluate("()=>{const c=document.querySelector('canvas');return {w:c.width,h:c.height,cw:c.clientWidth,ch:c.clientHeight}}")
        await b.close()
    Path(ROOT/"tests/e2e/results/pitchview_live.json").write_text(json.dumps({"canvas":cv,"samples":samples,"pageerrors":errs},ensure_ascii=False))
    st=[s['state'] for s in samples]; print({k:st.count(k) for k in set(st)}, "tracker counts:", sorted({s['trk'] or 0 for s in samples})[:5], "errs", errs)
    cs=[(i,round(s['c'])) for i,s in enumerate(samples) if s['c'] is not None]; print("cents over time (idx,c):", cs[::4])
    print("levels:", [round(s['lvl'],2) for s in samples if s['lvl'] is not None][::4]); print(cv)
asyncio.run(main())
