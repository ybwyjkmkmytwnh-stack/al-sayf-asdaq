"""يفتح dist/karaoke_standalone.html عبر file:// (كما عند النقر المزدوج) بميكروفون وهمي؛ يتحقق أن الإقلاع والميكروفون والتحليل تعمل."""
import asyncio, sys
from pathlib import Path
from playwright.async_api import async_playwright
F = Path(__file__).resolve().parents[2] / "dist" / "karaoke_standalone.html"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
        pg = await b.new_page(viewport={"width": 390, "height": 844})
        logs = []
        pg.on("console", lambda m: logs.append((m.type, m.text[:200]))); pg.on("pageerror", lambda e: logs.append(("pageerror", str(e)[:300])))
        await pg.goto(F.as_uri())
        st = None
        for _ in range(300):
            st = await pg.evaluate("() => window.__karaokeBoot && window.__karaokeBoot.state")
            if st and st != "loading": break
            await asyncio.sleep(0.2)
        print("boot:", st, "| secure:", await pg.evaluate("isSecureContext"))
        if st != "ready":
            print(await pg.evaluate("JSON.stringify(window.__karaokeBoot)")); print(logs[:5]); return 1
        r = await pg.evaluate("""async () => { const a = window.__karaoke.app; await a.ensureEngine(); const e = a.engine;
            await e.enableMic({headphones:true}); let mx=-999, voiced=0; for (let i=0;i<30;i++){ await new Promise(r=>setTimeout(r,100)); const l=e.latest; if(l){ mx=Math.max(mx,l.energyDb); if(l.voiced) voiced++; } }
            const s = e.status ? e.status() : {}; return JSON.stringify({sr: s.sampleRate ?? s.ctxSampleRate ?? null, latest: !!e.latest, f0: e.latest && e.latest.f0, maxEnergyDb: mx, voicedFrames: voiced}); }""")
        print("mic via standalone file:", r)
        await pg.get_by_text("ابدأ التدريب").first.click(); await asyncio.sleep(0.8)
        print("setup screen:", (await pg.evaluate("document.body.innerText.slice(0,80)")).replace("\n", " | "))
        print("errors:", [l for l in logs if l[0] in ("error", "pageerror")][:5])
        await b.close(); return 0
sys.exit(asyncio.run(main()))
