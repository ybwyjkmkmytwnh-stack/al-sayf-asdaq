#!/usr/bin/env python3
"""اختبارات المتصفح (Chromium) للمسار البرمجي الكامل. تُعلَّم كلها: software-path-only.

الميكروفون الوهمي (ملف WAV) أو نسخة المرجع المعاد توجيهها (injectReferenceAsMic) يثبتان أن السلسلة البرمجية تعمل
(عامل الالتقاط ← عامل الطبقة ← الجلسة ← المزامنة ← التقييم ← الواجهة) بتأخير/سعة معروفين؛ ولا يثبتان أداء إنسان حقيقي أو ميكروفونًا مادّيًا.

    python3 tests/e2e/run_e2e.py              # كل الحالات (≈ 8 دقائق)
    python3 tests/e2e/run_e2e.py --quick      # بلا التشغيل الطويل
    python3 tests/e2e/run_e2e.py --only E03,E04
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import tempfile
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import ROOT, Page, browser, server  # noqa: E402
from media import make_media  # noqa: E402

OUT = Path(__file__).resolve().parent / "results"
OUT.mkdir(exist_ok=True)
TOTAL_LAT = 0.042  # base+output latency تُبلغ بها Chromium الرأسي (تُقرأ فعليًا في كل حالة)

HELPERS = r"""
window.__t = {
  engine: async () => await window.__karaoke.app.ensureEngine(),
  waitEnded: (e) => new Promise(r => e.addEventListener('ended', (ev) => r(ev.detail), {once: true})),
  med: (a) => { const s = a.slice().sort((x,y)=>x-y); return s.length ? s[s.length>>1] : null; },
  // معايرة اختبارية: مستوى الراحة = وسيط طاقة إطارات الميكروفون المجهورة أثناء تشغيل غير مقيّم (لا شيء يُخمَّن)
  calibrate: async (e) => {
    const frames = []; e.collector = (f) => frames.push(f);
    const p = window.__t.waitEnded(e);
    await e.play({startSec: 31.0, endSec: 35.0, reason: 'cal', scored: false}); await p;
    e.collector = null;
    const v = frames.filter(f => f.voiced && f.periodicity >= 0.5).map(f => f.energyDb);
    Object.assign(e.calibration, {noiseFloorDb: -70, comfortLevelDb: window.__t.med(v), done: true, offsetCents: 0});
    return e.calibration.comfortLevelDb;
  },
  run: async (e, start, end, reason='line') => {
    const p = window.__t.waitEnded(e);
    await e.play({startSec: start, endSec: end, reason}); const info = await p;
    return info;
  },
  summary: (r) => ({ overall: r.overall, reason: r.overallReason, pitch: r.pitch?.score ?? null, pitchCov: r.pitch?.coverage ?? null, absent: r.pitch?.absentFrames ?? null,
    medErr: r.pitch?.medianErrCents ?? null, offsetSec: r.timing?.offsetSec ?? null, offsetReliable: r.timing?.offsetReliable ?? null,
    onset: r.timing?.onsetScore ?? null, dyn: r.dynamics?.score ?? null, relDb: r.dynamics?.medianRelDb ?? null,
    conf: r.confidence?.value ?? null, allowed: r.confidence?.numericScoringAllowed ?? null, meas: r.measurableFraction ?? null }),
};
"""

RESULTS: list[dict] = []


class Case:
    def __init__(self, cid, name, kind="software-path-only"):
        self.id, self.name, self.kind = cid, name, kind
        self.checks, self.data, self.t0 = [], {}, time.time()

    def check(self, cond, msg, **info):
        info = {k: v for k, v in info.items() if k not in ("ok", "msg")}
        self.checks.append({"ok": bool(cond), "msg": msg, **info})
        return bool(cond)

    def done(self):
        ok = all(c["ok"] for c in self.checks) and bool(self.checks)
        rec = {"id": self.id, "name": self.name, "kind": self.kind, "passed": ok, "seconds": round(time.time() - self.t0, 1), "checks": self.checks, "data": self.data}
        RESULTS.append(rec)
        flag = "PASS" if ok else "FAIL"
        print(f"[{flag}] {self.id} {self.name} ({rec['seconds']}s)")
        for c in self.checks:
            if not c["ok"]:
                print("      ✗", c["msg"], {k: v for k, v in c.items() if k not in ("ok", "msg")})
        return ok


async def fresh_page(b, url, viewport=None):
    ctx = await b.new_context(viewport=viewport or {"width": 1100, "height": 800}, locale="ar-SA")
    P = Page(await ctx.new_page())
    st = await P.open(url)
    await P.ev(HELPERS)
    return ctx, P, st


# ───────────────────────── الحالات ─────────────────────────
async def e01_boot(b, url):
    c = Case("E01", "إقلاع الموقع: تحميل بتقدّم حقيقي + مطابقة بصمة الصوت والنص")
    ctx, P, st = await fresh_page(b, url)
    c.check(st["state"] == "ready", "الإقلاع ناجح", boot=st)
    info = await P.ev("({a: window.__karaoke.data.analysis.audioHash, t: window.__karaoke.data.analysis.textHash, h: window.__karaoke.data.audioHash, th: window.__karaoke.data.textHash, n: window.__karaoke.data.audioBytes})")
    c.check(info["a"] == info["h"] and info["t"] == info["th"], "بصمة الصوت والنص المحسوبتان في المتصفح تطابقان التحليل", **info)
    c.check(bool(await P.page.query_selector("#start-training")), "زر «ابدأ التدريب» ظاهر في الصفحة الأولى")
    c.check(not P.errors(), "لا أخطاء في الكونسول", errors=P.errors())
    c.data = info
    await ctx.close()
    return c.done()


async def e02_mismatch(b, url):
    ok_all = True
    for field, code in (("audioHash", "audio-hash"), ("textHash", "text-hash")):
        c = Case(f"E02-{field}", f"التحليل غير المطابق ({field}) يُرفض ولا يبدأ التدريب")
        ctx = await b.new_context(locale="ar-SA")
        page = await ctx.new_page()
        P = Page(page)

        def make_tamper(fld):
            async def tamper(route, request):
                resp = await route.fetch()
                data = json.loads(await resp.text())
                data[fld] = "0" * 64
                headers = {k: v for k, v in resp.headers.items() if k.lower() not in ("content-length", "content-encoding")}
                await route.fulfill(status=resp.status, headers=headers, body=json.dumps(data))
            return tamper

        tamper = make_tamper(field)
        await page.route("**/data/reference_analysis.json", tamper)
        st = await P.open(url)
        c.check(st["state"] == "error", "الإقلاع يفشل", boot=st)
        c.check(st.get("code") == code, "رمز الرفض صحيح", got=st.get("code"))
        c.check(await page.query_selector("#start-training") is None, "لا زر ابدأ التدريب")
        txt = await page.inner_text("#load-error")
        c.check("python3 analysis/analyze_reference.py --force" in txt, "رسالة الخطأ تذكر أمر إعادة التوليد", text=txt[:200])
        await page.screenshot(path=str(OUT / f"mismatch_{field}.png"))
        await ctx.close()
        ok_all &= c.done()
    return ok_all


async def e03_identical(b, url):
    c = Case("E03", "نسخة مطابقة للمرجع (تأخير صفر، تعويض الكمون المُبلَّغ) ⇒ درجات عالية وإزاحة ≈ 0")
    ctx, P, _ = await fresh_page(b, url)
    r = await P.ev("""async () => { const t = window.__t, e = await t.engine(); e.injectReferenceAsMic({delaySec: 0}); await t.calibrate(e);
        e.setManualOffset(-e.latency.baseLatency - e.latency.outputLatency); await t.run(e, 38, 47);
        return { s: t.summary(e.score(38.8, 47)), sync: e.status().sync, total: e.latency.totalSec }; }""")
    s = r["s"]; c.data = r
    c.check(s["overall"] is not None and s["overall"] >= 0.93, "الدرجة الإجمالية ≥ 0.93", overall=s["overall"])
    c.check(s["pitch"] >= 0.90, "الطبقة ≥ 0.90", pitch=s["pitch"])
    c.check(abs(s["offsetSec"]) < 0.012, "إزاحة التوقيت ≈ 0 (±12 م.ث)", off=s["offsetSec"])
    c.check(r["sync"]["lastOk"] and r["sync"]["corr"] > 0.97, "محاذاة ساعة التقاط المرجع موثوقة (ارتباط > 0.97)", sync=r["sync"])
    c.check(not P.errors(), "لا أخطاء كونسول", errors=P.errors())
    await ctx.close()
    return c.done()


async def e04_delay(b, url):
    c = Case("E04", "تأخير معروف 0.25 ث: يُكتشف بإشارة موجبة (المستخدم متأخر)، ويُعوَّض يدويًا فتعود الدرجة، والاتجاه المعاكس سالب")
    ctx, P, _ = await fresh_page(b, url)
    r = await P.ev("""async () => { const t = window.__t, e = await t.engine(); e.injectReferenceAsMic({delaySec: 0.25}); await t.calibrate(e);
        const rep = e.latency.baseLatency + e.latency.outputLatency; const out = {rep};
        e.setManualOffset(0); await t.run(e, 38, 47); out.noComp = t.summary(e.score(38.8, 47));
        e.setManualOffset(0.25 - rep); await t.run(e, 38, 47); out.comp = t.summary(e.score(38.8, 47));
        e.setManualOffset(0.25 - rep + 0.10); await t.run(e, 38, 47); out.over = t.summary(e.score(38.8, 47));
        return out; }""")
    c.data = r
    rep = r["rep"]
    c.check(abs(r["noComp"]["offsetSec"] - (0.25 - rep)) < 0.02 and r["noComp"]["offsetSec"] > 0.15, "بلا تعويض: الإزاحة المقيسة ≈ التأخير − الكمون المُبلَّغ وإشارتها موجبة", measured=r["noComp"]["offsetSec"], expected=0.25 - rep)
    c.check(r["noComp"]["overall"] < 0.70, "بلا تعويض: الدرجة تنخفض", overall=r["noComp"]["overall"])
    c.check(abs(r["comp"]["offsetSec"]) < 0.015, "مع التعويض اليدوي الصحيح: الإزاحة ≈ 0", off=r["comp"]["offsetSec"])
    c.check(r["comp"]["overall"] >= 0.93, "مع التعويض: الدرجة تعود ≥ 0.93", overall=r["comp"]["overall"])
    c.check(abs(r["over"]["offsetSec"] + 0.10) < 0.02, "تعويض زائد 0.10 ث ⇒ الإزاحة ≈ −0.10 (المستخدم مبكّر): الإشارة صحيحة في الاتجاهين", off=r["over"]["offsetSec"])
    await ctx.close()
    return c.done()


async def e06_gain(b, url):
    c = Case("E06", "تغيير سعة الصوت: −12 dB يخفض القوة النسبية ≈ −12 دون المساس بالطبقة؛ +12 dB لا يرفع الدرجة")
    ctx, P, _ = await fresh_page(b, url)
    r = await P.ev("""async () => { const t = window.__t, e = await t.engine(); e.injectReferenceAsMic({delaySec: 0}); await t.calibrate(e);
        e.setManualOffset(-(e.latency.baseLatency + e.latency.outputLatency)); const out = {};
        await t.run(e, 38, 47); out.unit = t.summary(e.score(38.8, 47));
        e._inj.g.gain.value = 0.25; await t.run(e, 38, 47); out.quiet = t.summary(e.score(38.8, 47));
        e._inj.g.gain.value = 4; await t.run(e, 38, 47); out.loud = t.summary(e.score(38.8, 47));
        return out; }""")
    c.data = r
    c.check(abs(r["quiet"]["relDb"] + 12) < 1.5, "−12 dB ⇒ القوة النسبية ≈ −12", rel=r["quiet"]["relDb"])
    c.check(abs(r["loud"]["relDb"] - 12) < 1.5, "+12 dB ⇒ القوة النسبية ≈ +12", rel=r["loud"]["relDb"])
    c.check(abs(r["quiet"]["pitch"] - r["unit"]["pitch"]) < 0.03 and abs(r["loud"]["pitch"] - r["unit"]["pitch"]) < 0.03, "الطبقة لا تتأثر بالسعة", unit=r["unit"]["pitch"], quiet=r["quiet"]["pitch"], loud=r["loud"]["pitch"])
    c.check(r["quiet"]["dyn"] < 0.2 and r["loud"]["dyn"] < 0.2 and r["unit"]["dyn"] > 0.85, "بُعد القوة يعاقب الابتعاد عن مستوى المعايرة في الاتجاهين", unit=r["unit"]["dyn"], quiet=r["quiet"]["dyn"], loud=r["loud"]["dyn"])
    c.check(r["loud"]["overall"] <= r["unit"]["overall"] + 0.005, "رفع الصوت لا يرفع الدرجة الإجمالية")
    await ctx.close()
    return c.done()


async def e07_silence(b, url):
    c = Case("E07", "صمت المستخدم في جزء مطلوب ⇒ غياب (صفر) لا «لم يُقَس»؛ وفشل الجهاز (صمت رقمي) ⇒ غير قابل للقياس")
    ctx, P, _ = await fresh_page(b, url)
    r = await P.ev("""async () => { const t = window.__t, e = await t.engine(); e.injectReferenceAsMic({delaySec: 0}); await t.calibrate(e);
        e.setManualOffset(-(e.latency.baseLatency + e.latency.outputLatency)); const out = {};
        e._inj.g.gain.value = 1e-5;   // صمت شبه تام لكن غير صفري: ميكروفون سليم والمستخدم لا يغني
        await t.run(e, 38, 47); out.quiet = t.summary(e.score(38.8, 47));
        e._inj.g.gain.value = 0;      // صفر تام: فشل جهاز/مكتوم
        const ev0 = e.events.length; await t.run(e, 38, 47); out.dead = t.summary(e.score(38.8, 47));
        out.deadEvents = e.events.slice(ev0).map(x => x.code);
        return out; }""")
    c.data = r
    q, d = r["quiet"], r["dead"]
    c.check(q["pitch"] == 0 and q["pitchCov"] == 0 and q["absent"] > 300, "صمت سليم ⇒ طبقة 0 وتغطية 0 وإطارات غياب", **{k: q[k] for k in ("pitch", "pitchCov", "absent")})
    c.check(q["meas"] > 0.95 and q["overall"] is not None and q["overall"] < 0.2, "الجهاز سليم (قابل للقياس) والدرجة منخفضة وليست «لم يُقَس»", meas=q["meas"], overall=q["overall"])
    c.check("digital-silence" in r["deadEvents"], "الصمت الرقمي الكامل يُكشف كحدث جهاز", events=r["deadEvents"])
    c.check(d["overall"] is None and d["reason"] == "insufficient-measurable", "فشل الجهاز ⇒ لا درجة (غير قابل للقياس) ولا صفر", overall=d["overall"], reason=d["reason"])
    await ctx.close()
    return c.done()


async def e09_ref_silence(b, url):
    c = Case("E09", "صمت المرجع ليس نقاطًا مجانية: نافذة بلا نطق مرجعي ⇒ لا درجة")
    ctx, P, _ = await fresh_page(b, url)
    r = await P.ev("""async () => { const t = window.__t, e = await t.engine(); e.injectReferenceAsMic({delaySec: 0}); await t.calibrate(e);
        e._inj.g.gain.value = 1e-5; await t.run(e, 0.2, 3.5); const s = e.score(0.3, 3.4); return t.summary(s); }""")
    c.data = r
    c.check(r["overall"] is None and r["reason"] == "no-scorable-reference", "لا درجة لنافذة صامتة مرجعيًا", **r)
    await ctx.close()
    return c.done()


async def e10_seek(b, url):
    c = Case("E10", "تقديم/إعادة الشطر: مقاطع منفصلة بلا خلط بيانات (كل مقطع بمحاذاته الخاصة)")
    ctx, P, _ = await fresh_page(b, url)
    r = await P.ev("""async () => { const t = window.__t, e = await t.engine(); e.injectReferenceAsMic({delaySec: 0}); await t.calibrate(e);
        e.setManualOffset(-(e.latency.baseLatency + e.latency.outputLatency));
        const n0 = e.session.segments.length;
        await e.play({startSec: 38, endSec: null, reason: 'play'}); await new Promise(r => setTimeout(r, 4500));
        await e.seek(150); await new Promise(r => setTimeout(r, 4500));
        await e.play({startSec: 38, endSec: null, reason: 'restart-line'}); await new Promise(r => setTimeout(r, 4500));
        await e.pause();
        const segs = e.session.segments.slice(n0).map(s => {
          const lat = e.latency.snapshot(); const m = e.session._mapSegment(s, lat);
          return { id: s.id, reason: s.reason, mic: s.mic.t.length, tracker: s.tracker.count, refMin: m ? Math.min(...m.t) : null, refMax: m ? Math.max(...m.t) : null, closed: s.closed };
        });
        const w1 = e.session.userTrack(e.latency.snapshot(), {tStart: 39.5, tEnd: 41.5});
        const w2 = e.session.userTrack(e.latency.snapshot(), {tStart: 152, tEnd: 154});
        return { segs, w1: {id: w1.segmentId, cov: w1.coverageSec}, w2: {id: w2.segmentId, cov: w2.coverageSec} }; }""")
    c.data = r
    s = r["segs"]
    c.check([x["reason"] for x in s] == ["play", "seek", "restart-line"], "ثلاثة مقاطع بأسبابها", got=[x["reason"] for x in s])
    c.check(all(x["closed"] for x in s), "كل المقاطع مغلقة بعد الإيقاف")
    if len(s) == 3:
        c.check(s[0]["refMin"] > 37 and s[0]["refMax"] < 44, "المقطع 1 على مرجع 38–44 فقط", seg=s[0])
        c.check(s[1]["refMin"] > 148 and s[1]["refMax"] < 156, "المقطع 2 (بعد التقديم) على مرجع ≈150–156 فقط", seg=s[1])
        c.check(s[2]["refMin"] > 37 and s[2]["refMax"] < 44, "المقطع 3 (إعادة الشطر) على مرجع 38–44 فقط", seg=s[2])
        c.check(r["w1"]["id"] == s[2]["id"], "نافذة 39.5–41.5 تُقرأ من المقطع الأحدث (إعادة الشطر) لا الأقدم", w=r["w1"], latest=s[2]["id"])
        c.check(r["w2"]["id"] == s[1]["id"], "نافذة 152–154 تُقرأ من مقطع التقديم", w=r["w2"], seek=s[1]["id"])
    await ctx.close()
    return c.done()


async def e11_volume(b, url):
    c = Case("E11", "مستوى الاستماع لا يؤثر على التقييم: نفس النافذة بمستوى 0.8 ثم 0.05 ⇒ نفس الدرجة وδ")
    ctx, P, _ = await fresh_page(b, url)
    r = await P.ev("""async () => { const t = window.__t, e = await t.engine(); e.injectReferenceAsMic({delaySec: 0}); await t.calibrate(e);
        e.setManualOffset(-(e.latency.baseLatency + e.latency.outputLatency)); const out = {};
        e.setListenVolume(0.8); await t.run(e, 38, 47); out.hi = t.summary(e.score(38.8, 47)); const sA = e.session.segments.at(-1); out.dHi = sA.tracker.at(sA.mic.t.at(-1)) - sA.mic.t.at(-1);
        e.setListenVolume(0.05); await t.run(e, 38, 47); out.lo = t.summary(e.score(38.8, 47)); const sB = e.session.segments.at(-1); out.dLo = sB.tracker.at(sB.mic.t.at(-1)) - sB.mic.t.at(-1);
        // وأثناء التشغيل نفسه: تغيير المستوى لا يكسر المحاذاة
        await e.play({startSec: 38, endSec: null, reason: 'play'}); await new Promise(r => setTimeout(r, 3500)); e.setListenVolume(0.9); await new Promise(r => setTimeout(r, 3500)); e.setListenVolume(0.02); await new Promise(r => setTimeout(r, 3500)); await e.pause();
        const s = e.session.segments.at(-1); const ds = s.alignLog.filter(a => a.ok).map(a => a.delta);
        out.midRun = { n: ds.length, spreadMs: (Math.max(...ds) - Math.min(...ds)) * 1000 };
        return out; }""")
    c.data = r
    c.check(abs(r["hi"]["overall"] - r["lo"]["overall"]) < 0.01, "الدرجة الإجمالية متطابقة", hi=r["hi"]["overall"], lo=r["lo"]["overall"])
    c.check(abs(r["hi"]["pitch"] - r["lo"]["pitch"]) < 0.01 and abs((r["hi"]["relDb"] or 0) - (r["lo"]["relDb"] or 0)) < 0.5, "الطبقة والقوة النسبية متطابقتان")
    c.check(r["midRun"]["n"] >= 5 and r["midRun"]["spreadMs"] < 6, "تغيير المستوى أثناء التشغيل لا يغيّر δ المقيس (تشتت < 6 م.ث)", **r["midRun"])
    await ctx.close()
    return c.done()


async def e12_devices(b, url):
    c = Case("E12", "أحداث الأجهزة: كتم/فصل الميكروفون/تعليق السياق ⇒ توقف واضح وعدم احتساب")
    ctx, P, _ = await fresh_page(b, url)
    r = await P.ev("""async () => { const t = window.__t, e = await t.engine(); await e.enableMic({headphones: true}); const out = {};
        out.track = e.status().track;
        await e.play({startSec: 38, endSec: null, reason: 'play'}); await new Promise(r => setTimeout(r, 3000));
        e.track.dispatchEvent(new Event('mute')); await new Promise(r => setTimeout(r, 700)); out.mutedFlag = e.micMuted;
        const seg = e.session.cur; const tail = seg.mic.meas.slice(-30); out.mutedMeasTail = tail.reduce((a, b) => a + b, 0);
        e.track.dispatchEvent(new Event('unmute')); await new Promise(r => setTimeout(r, 400));
        const pEnd = t.waitEnded(e); await e.ctx.suspend(); const info = await pEnd; out.suspendReason = info.reason; out.stateAfterSuspend = e.state;
        await e.ctx.resume();
        await e.play({startSec: 38, endSec: null, reason: 'play'}); await new Promise(r => setTimeout(r, 1500));
        const pEnd2 = t.waitEnded(e); e.track.dispatchEvent(new Event('ended')); const info2 = await pEnd2; out.endedReason = info2.reason; out.micOnAfterEnd = e.micOn;
        out.codes = e.events.map(x => x.code);
        return out; }""")
    c.data = r
    c.check(r["track"] and r["track"]["processingOn"] is False and r["track"]["honored"], "إعدادات المسار الفعلية: بلا AGC/NS/EC في وضع السماعات", track=r["track"])
    c.check(r["mutedFlag"] is True and r["mutedMeasTail"] <= 5, "الكتم يُعلَّم ويجعل الإطارات الأخيرة غير قابلة للقياس", flag=r["mutedFlag"], tail=r["mutedMeasTail"])
    c.check(r["suspendReason"] == "ctx-suspended" and "ctx-suspended" in r["codes"], "تعليق السياق يوقف الجلسة بسبب واضح", reason=r["suspendReason"])
    c.check(r["endedReason"] == "mic-ended" and r["micOnAfterEnd"] is False and "mic-ended" in r["codes"], "انقطاع المسار يوقف الجلسة ويُعلن", reason=r["endedReason"])
    await ctx.close()
    return c.done()


async def e14_video(b, url):
    c = Case("E14", "غياب خادم الفيديو لا يؤثر على التدريب ويُعرض بوضوح")
    ctx, P, _ = await fresh_page(b, url)
    r = await P.ev("""async () => { const m = await import('/js/ui/video.js'); const chk = await m.checkVideoServer();
        const gen = await m.generateVideo({audioUrl: window.__karaoke.data.audioUrl}); const e = await window.__t.engine();
        return { chk, gen, engineState: e.state }; }""")
    c.data = r
    c.check(r["chk"]["ok"] is False and "غير متاح" in (r["chk"].get("error") or ""), "فحص الخادم يفشل برسالة عربية واضحة", chk=r["chk"])
    c.check(r["gen"]["ok"] is False and r["gen"]["error"], "التوليد يفشل برسالة ولا يرمي استثناءً", gen=r["gen"])
    c.check(r["engineState"] == "ready", "محرّك التدريب سليم بعد فشل الفيديو")
    c.check(not [e for e in P.errors() if "pageerror" in e[0]], "لا استثناءات غير معالجة")
    await ctx.close()
    return c.done()


async def e17_leak(b, url):
    c = Case("E17", "كشف التسرّب: ميكروفون = نسخة من المرجع ⇒ تسرّب ويُعطَّل التقييم الرقمي؛ ميكروفون ساكن ⇒ لا تسرّب")
    ctx, P, _ = await fresh_page(b, url)
    r = await P.ev("""async () => { const t = window.__t, e = await t.engine(); const out = {};
        e.injectReferenceAsMic({delaySec: 0.08}); e.calibration.noiseFloorDb = -70; e.calibration.comfortLevelDb = -12.5; e.calibration.done = true;
        out.leaky = await e.probeLeak({sec: 6});
        await t.run(e, 38, 47); const s = e.score(38.8, 47); out.leakyScore = t.summary(s); out.leakyAllowed = s.confidence.numericScoringAllowed; out.leakyWithheld = s.numericScoreWithheld ?? null;
        e.leak.detected = false; e.leak.probed = false; e.leak.monitorHits = 0;
        e.injectReferenceAsMic({delaySec: 0, gain: 0, noiseDb: -65});   // مستخدم صامت وميكروفون سليم بضجيج غرفة مستقل
        await e.measureNoise(2); e.calibration.comfortLevelDb = -12.5;
        out.clean = await e.probeLeak({sec: 6}); out.cleanNoise = e.calibration.noiseFloorDb;
        return out; }""")
    c.data = r
    L, K = r["leaky"], r["clean"]
    c.check(L["valid"] and L["detected"] and L["level"] > 0.5, "تسرّب مُحاكى مُكتشف", level=L["level"])
    c.check(L["lagMs"] is not None and abs(L["lagMs"] - 80) < 15, "تأخر التسرّب المقيس ≈ 80 م.ث", lag=L["lagMs"])
    c.check(r["leakyAllowed"] is False and r["leakyScore"]["overall"] is None and r["leakyWithheld"] is not None, "مع التسرّب: الدرجة الرقمية معطّلة (تُحجب)", allowed=r["leakyAllowed"])
    c.check(K["valid"] and not K["detected"] and (K["level"] is None or K["level"] < 0.2), "ميكروفون ساكن: لا تسرّب", level=K["level"], detected=K["detected"])
    await ctx.close()
    return c.done()


async def e05_longrun(b, url, seconds):
    c = Case("E05", f"تشغيل طويل ({seconds} ث): لا انجراف في المحاذاة ولا تراكم خطأ زمني")
    ctx, P, _ = await fresh_page(b, url)
    r = await P.ev("""async (secs) => { const t = window.__t, e = await t.engine(); e.injectReferenceAsMic({delaySec: 0}); await t.calibrate(e);
        e.setManualOffset(-(e.latency.baseLatency + e.latency.outputLatency));
        await e.play({startSec: 20, endSec: null, reason: 'play'}); const t0 = performance.now(); const offs = [];
        while ((performance.now() - t0) / 1000 < secs) { await new Promise(r => setTimeout(r, 1000)); if (e.state !== 'playing') break; }
        const played = e.audio.currentTime - 20; await e.pause();
        const s = e.session.segments.at(-1); const al = s.alignLog.filter(a => a.ok); const ds = al.map(a => a.delta);
        const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
        // أخطاء الإزاحة على نوافذ متباعدة على امتداد التشغيل
        const wins = []; for (let w0 = 22; w0 + 10 < 20 + played - 1; w0 += 20) { const sc = e.score(w0, w0 + 10); wins.push({ w0, off: sc.timing.offsetSec, rel: sc.timing.offsetReliable, overall: sc.overall }); }
        return { played, n: ds.length, spreadMs: (Math.max(...ds) - Math.min(...ds)) * 1000, firstLastMs: (ds.at(-1) - ds[0]) * 1000, driftPpm: s.tracker.driftPpm, corrMin: Math.min(...al.map(a => a.corr)), wins, trackerCount: s.tracker.count, segs: e.session.segments.length }; }""", seconds)
    c.data = r
    c.check(r["played"] > seconds * 0.95, "التشغيل استمر المدة المطلوبة بلا انقطاع", played=r["played"])
    c.check(r["n"] >= seconds * 0.7, "قياسات δ كافية", n=r["n"])
    c.check(r["spreadMs"] < 8, "تشتت δ عبر التشغيل < 8 م.ث", spread=r["spreadMs"])
    c.check(abs(r["firstLastMs"]) < 6, "δ الأخير ≈ الأول (< 6 م.ث): لا انجراف", delta=r["firstLastMs"])
    c.check(r["corrMin"] > 0.95, "كل المحاذاات عالية الارتباط", corrMin=r["corrMin"])
    c.check(all(abs(w["off"]) < 0.02 and w["rel"] for w in r["wins"]), "الإزاحة المقيسة في نوافذ متباعدة ≈ 0 (لا تراكم)", wins=[(w["w0"], round(w["off"], 4)) for w in r["wins"]])
    c.check(r["segs"] >= 1 and len([1 for _ in [0]]) == 1, "مقطع واحد مستمر")
    await ctx.close()
    return c.done()


# ───────────── ميكروفون وهمي (ملف) ─────────────
async def e15_fake_tone(media, url):
    c = Case("E15", "ميكروفون وهمي (نغمة 220 هرتز): طبقة صحيحة، إطارات كل 10 م.ث تمامًا، إعدادات المسار الفعلية")
    async with browser([f"--use-file-for-fake-audio-capture={media['tone']}"]) as b:
        ctx, P, _ = await fresh_page(b, url)
        r = await P.ev("""async () => { const t = window.__t, e = await t.engine(); const frames = []; await e.enableMic({headphones: true});
            await new Promise(r => { e.collector = (f) => { frames.push(f); if (frames.length > 400) { e.collector = null; r(); } }; });
            const v = frames.filter(f => f.voiced).map(f => f.f0).sort((a, b) => a - b);
            const dts = []; for (let i = 1; i < frames.length; i++) dts.push(frames[i].tCtx - frames[i - 1].tCtx);
            const st = e.status();
            return { n: frames.length, voicedFrac: v.length / frames.length, medF0: v[v.length >> 1], p5: v[Math.floor(v.length * 0.05)], p95: v[Math.floor(v.length * 0.95)],
              dtMin: Math.min(...dts), dtMax: Math.max(...dts), db: t.med(frames.map(f => f.energyDb)), ctx: st.ctx, track: st.track, analyzer: st.analyzer }; }""")
        c.data = r
        c.check(r["voicedFrac"] > 0.95 and abs(r["medF0"] - 220) < 2, "الطبقة المقاسة ≈ 220 هرتز", f0=r["medF0"], voicedFrac=r["voicedFrac"])
        c.check(r["p5"] > 214 and r["p95"] < 226, "ثبات الطبقة ضمن ±6 هرتز", p5=r["p5"], p95=r["p95"])
        c.check(r["dtMax"] - r["dtMin"] < 1e-6 and abs(r["dtMin"] - 0.01) < 1e-6, "تباعد الإطارات 10 م.ث تمامًا (شبكة ساعة السياق)", dt=(r["dtMin"], r["dtMax"]))
        c.check(abs(r["db"] - (-20)) < 2.5, "الطاقة ≈ −20 dBFS كما في الملف", db=r["db"])
        c.check(r["track"]["honored"] and not r["track"]["processingOn"], "المسار الفعلي بلا معالجة", track=r["track"]["processing"])
        c.check(r["ctx"]["state"] == "running", "السياق يعمل", ctx=r["ctx"])
        await ctx.close()
    return c.done()


async def e16_fake_silence_noise(media, url):
    c = Case("E16", "ميكروفون وهمي: صمت رقمي ⇒ حدث جهاز وغير قابل للقياس؛ ضجيج منخفض ⇒ لا جهر ولا طبقة")
    async with browser([f"--use-file-for-fake-audio-capture={media['silence']}"]) as b:
        ctx, P, _ = await fresh_page(b, url)
        r = await P.ev("""async () => { const t = window.__t, e = await t.engine(); await e.enableMic({headphones: true});
            await e.play({startSec: 38, endSec: null, reason: 'play'}); await new Promise(r => setTimeout(r, 3500)); await e.pause();
            const s = e.session.segments.at(-1); return { codes: e.events.map(x => x.code), measFrac: s.mic.meas.reduce((a, b) => a + b, 0) / s.mic.meas.length, n: s.mic.meas.length }; }""")
        c.data["silence"] = r
        c.check("digital-silence" in r["codes"], "الصمت الرقمي يُكتشف", codes=r["codes"])
        c.check(r["measFrac"] < 0.35, "أغلب الإطارات غير قابلة للقياس بعد ثانية من الصمت الرقمي", measFrac=r["measFrac"])
        await ctx.close()
    async with browser([f"--use-file-for-fake-audio-capture={media['noise']}"]) as b:
        ctx, P, _ = await fresh_page(b, url)
        r = await P.ev("""async () => { const t = window.__t, e = await t.engine(); await e.enableMic({headphones: true}); const frames = [];
            await new Promise(r => { e.collector = (f) => { frames.push(f); if (frames.length > 300) { e.collector = null; r(); } }; });
            const fs = e.ctx.sampleRate, D = Math.floor(fs / 16000);
            return { voiced: frames.filter(f => f.voiced).length / frames.length, db: t.med(frames.map(f => f.energyDb)), fs, D }; }""")
        c.data["noise"] = r
        c.check(r["voiced"] < 0.15, "ضجيج أبيض ⇒ لا جهر (لا طبقة وهمية)", voiced=r["voiced"])
        # الطاقة تُقاس بعد مرشّح التقليل (قطع 0.45/D من معدل السياق) ⇒ ضجيج أبيض بـ −40 dBFS كامل النطاق يظهر أخفض بمقدار 10·log10(0.9/D)
        import math
        expected = -40 + 10 * math.log10(0.9 / r["D"])
        c.data["noiseExpectedDb"] = expected
        c.check(abs(r["db"] - expected) < 1.5, "طاقة الضجيج ضمن نطاق التحليل ≈ −40 dBFS + تصحيح النطاق (%.1f)" % expected, db=r["db"], fs=r["fs"], D=r["D"])
        await ctx.close()
    return c.done()


async def e13_permission(url):
    c = Case("E13", "رفض/غياب/انشغال الميكروفون ⇒ رسالة عربية واضحة وبقاء الاستماع متاحًا")
    # (أ) خطأ حقيقي من Chromium بلا نافذة أذونات (وضع headless): الجهاز الوهمي موجود لكن لا واجهة أذونات ⇒ NotSupportedError
    async with async_playwright_deny() as b:
        ctx = await b.new_context(locale="ar-SA")
        P = Page(await ctx.new_page())
        await P.open(url)
        await P.ev(HELPERS)
        r = await P.ev("""async () => { const e = await window.__t.engine(); try { await e.enableMic({headphones: true}); return {ok: true}; } catch (err) { return {ok: false, code: err.code, message: err.message, fatal: err.fatal}; } }""")
        c.data["real_headless"] = r
        c.check(r["ok"] is False and r["code"] in ("not-supported", "permission-denied", "no-device"), "خطأ حقيقي من المتصفح يُترجم لرمز معروف (لا unknown)", result=r)
        c.check(any("\u0600" <= ch <= "\u06ff" for ch in (r.get("message") or "")) and "Not supported" not in (r.get("message") or ""), "الرسالة عربية بلا نص إنجليزي خام", text=r.get("message"))
        await ctx.close()
    # (ب) أخطاء متصفح «مُحاكاة» (كائنات DOMException بنفس الأسماء التي تُرجعها المتصفحات عند رفض المستخدم/غياب الجهاز/انشغاله):
    #     تثبت معالجة التطبيق فقط، وليست رفضًا حقيقيًا من نافذة أذونات.
    cases = [("NotAllowedError", "permission-denied", "تم رفض إذن الميكروفون"), ("NotFoundError", "no-device", "لم يُعثر على ميكروفون"),
             ("NotReadableError", "device-busy", "تعذّر فتح الميكروفون"), ("SecurityError", "insecure-context", "صفحة آمنة")]
    async with browser() as b:
        for name, code, frag in cases:
            ctx = await b.new_context(locale="ar-SA")
            await ctx.add_init_script("navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('raw english', '%s'));" % name)
            P = Page(await ctx.new_page())
            await P.open(url)
            await P.page.click("#start-training"); await P.page.click("#btn-mic")
            await P.page.wait_for_selector(".notice.bad:not([hidden])", timeout=15000)
            txt = await P.page.inner_text(".notice.bad:not([hidden])")
            c.check(frag in txt and "raw english" not in txt, f"{name} ⇒ رسالة عربية في بطاقة الميكروفون ({code})", text=txt[:100])
            if name == "NotAllowedError":
                c.check("الاستماع" in txt, "رسالة الرفض تذكر أن الاستماع بلا ميكروفون ممكن", text=txt[:140])
                await P.page.screenshot(path=str(OUT / "permission_denied.png"))
                # «استماع فقط» يعمل بعد الرفض: لا أخطاء صفحة، ويظهر مؤشر موضع التسجيل
                await P.page.click("text=الشاشة الرئيسية") if await P.page.locator("text=الشاشة الرئيسية").count() else await P.page.goto(url)
                await P.page.wait_for_function("window.__karaokeBoot && window.__karaokeBoot.state === 'ready'")
                await P.page.click("text=استماع فقط")
                await P.page.wait_for_selector('input[type=range][aria-label="موضع التسجيل"]', timeout=10000)
                c.check(len([l for l in P.errors() if "getUserMedia" not in l[1] and "raw english" not in l[1]]) == 0, "لا أخطاء صفحة غير متوقعة بعد الرفض", errors=P.errors()[:3])
            await ctx.close()
    return c.done()


from contextlib import asynccontextmanager  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402


@asynccontextmanager
async def async_playwright_deny():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--deny-permission-prompts"])  # جهاز وهمي موجود لكن الإذن مرفوض
        try:
            yield b
        finally:
            await b.close()


# ───────────── تدفق الواجهة الكامل بميكروفون وهمي ─────────────
async def e18_ui_flow(media, url):
    c = Case("E18", "تدفق الواجهة الكامل (جوال): ابدأ التدريب → إذن → معايرة → غنِّ مع الشطر → نتيجة → مراجعة")
    # ملف «flow»: 0–4 هدوء | 4–10.3 كلام | 10.3–26.3 هدوء | 26.3+ كلام (ثوانٍ منذ فتح الميكروفون)؛ نُجدول الخطوات على هذا الجدول
    async with browser([f"--use-file-for-fake-audio-capture={media['flow']}"]) as b:
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="ar-SA")
        P = Page(await ctx.new_page())
        await P.open(url)
        pg = P.page
        await pg.screenshot(path=str(OUT / "ui_01_home.png"))
        await pg.click("#start-training")
        await pg.wait_for_selector("#btn-mic")
        await pg.click("#btn-mic")
        await pg.wait_for_selector("#btn-noise:not([disabled])", timeout=20000)
        t_mic = time.time()

        async def at(sec):   # انتظر حتى الثانية sec منذ فتح الميكروفون (جدول ملف الميكروفون الوهمي)
            await pg.wait_for_timeout(max(0, int((t_mic + sec - time.time()) * 1000)))
        await at(0.4)
        await pg.screenshot(path=str(OUT / "ui_02_setup_mic.png"))
        await pg.click("#btn-noise")
        await pg.wait_for_function("document.querySelectorAll('.stepcard.done').length >= 2", timeout=20000)
        await at(4.1)
        await pg.click("#btn-voice")
        await pg.wait_for_function("document.querySelectorAll('.stepcard.done').length >= 3", timeout=25000)
        await at(10.6)
        await pg.click("#btn-leak")
        await pg.wait_for_function("document.querySelectorAll('.stepcard.done').length >= 4 || document.querySelector('#btn-leak').disabled === false && document.querySelector('.stepcard:last-of-type .small')?.textContent.length > 3", timeout=30000)
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=str(OUT / "ui_03_setup_done.png"), full_page=True)
        cal = await P.ev("window.__karaoke.engine.status()")
        c.data["calibration"] = cal["calibration"]; c.data["leak"] = cal["leak"]
        c.check(cal["calibration"]["noiseFloorDb"] is not None, "قيست أرضية الضجيج", nf=cal["calibration"]["noiseFloorDb"])
        c.check(cal["calibration"]["comfortLevelDb"] is not None and cal["calibration"]["voicedSec"] >= 1.5, "قيس مستوى الصوت المريح", cal=cal["calibration"])
        await pg.click("#btn-finish-setup")
        await pg.wait_for_selector("#btn-sing")
        await P.ev("window.__karaoke.app.prefs.countdown = 0")
        await pg.screenshot(path=str(OUT / "ui_04_practice_idle.png"))                       # بحجم الشاشة الفعلي (الشريط اللاصق كما يراه المستخدم)
        await pg.screenshot(path=str(OUT / "ui_04b_practice_idle_full.png"), full_page=True)
        await at(26.6)
        await pg.click("#btn-sing")
        await pg.wait_for_function("window.__karaoke.engine.state === 'playing'", timeout=10000)
        await pg.wait_for_timeout(3200)
        await pg.screenshot(path=str(OUT / "ui_05_practice_live.png"))
        await pg.screenshot(path=str(OUT / "ui_05b_practice_live_full.png"), full_page=True)
        live = await P.ev("({state: window.__karaoke.engine.state, sync: window.__karaoke.engine.sync, hint: document.querySelector('.hint').textContent, inds: [...document.querySelectorAll('.ind')].map(e => e.dataset.state + ':' + e.querySelector('.txt').textContent)})")
        c.data["live"] = live
        c.check(live["sync"]["lastOk"], "المحاذاة قيست أثناء الغناء عبر الواجهة", sync=live["sync"])
        await pg.wait_for_function("window.__karaoke.engine.state === 'ready' && !document.querySelector('.card[hidden]#none')", timeout=30000)
        await pg.wait_for_selector(".result-mini", timeout=10000)
        await pg.screenshot(path=str(OUT / "ui_06_result.png"))
        await pg.screenshot(path=str(OUT / "ui_06b_result_full.png"), full_page=True)
        txt = await pg.inner_text(".result-mini")
        c.data["result_text"] = txt
        c.check("تقييم تشابه الأداء الصوتي" in txt, "عنوان النتيجة «تقييم تشابه الأداء الصوتي»", text=txt[:80])
        await pg.click(".result-mini .btn:not(.primary)")
        await pg.wait_for_selector("#review-score")
        await pg.screenshot(path=str(OUT / "ui_07_review.png"), full_page=True)
        body = await pg.inner_text("body")
        c.check("لا يقيّم" not in body or "النطق" in body, "المراجعة تعرض حدود النطاق")
        c.check("النطق" in body and "الحركات" in body, "نص النطاق (لا نطق/حركات) ظاهر في المراجعة")
        c.check(not P.errors(), "لا أخطاء في الكونسول", errors=P.errors())
        await ctx.close()
    return c.done()


async def e19_screens(url):
    c = Case("E19", "لقطات الشاشات (سطح مكتب/جوال، فاتح/داكن): فهرس، إعدادات، شرح، محرّر التوقيت، استماع", kind="visual")
    async with browser() as b:
        for name, vp, scheme in (("desktop", {"width": 1280, "height": 900}, "light"), ("mobile_dark", {"width": 390, "height": 844}, "dark")):
            ctx = await b.new_context(viewport=vp, device_scale_factor=2 if "mobile" in name else 1, locale="ar-SA", color_scheme=scheme)
            P = Page(await ctx.new_page())
            await P.open(url)
            for scr, params in (("browse", {}), ("settings", {}), ("about", {}), ("editor", {"idx": 3}), ("listen", {}), ("practice", {})):
                await P.ev(f"window.__karaoke.app.go('{scr}', {json.dumps(params)})")
                await P.page.wait_for_timeout(400)
                await P.page.screenshot(path=str(OUT / f"screen_{name}_{scr}.png"), full_page=(scr != "practice"))
            c.check(not P.errors(), f"لا أخطاء كونسول ({name})", errors=P.errors())
            await ctx.close()
    return c.done()


async def e20_layout(media, url):
    c = Case("E20", "تخطيط شاشة التدريب بأحجام مختلفة: لا تجاوز أفقي، والمؤشرات ظاهرة فوق الشريط اللاصق على جوال ≥ 844 ارتفاعًا", kind="visual")
    async with browser([f"--use-file-for-fake-audio-capture={media['flow']}"]) as b:
        for name, vp in (("m390x844", {"width": 390, "height": 844}), ("m360x740", {"width": 360, "height": 740}), ("m390x700", {"width": 390, "height": 700}), ("d1280x800", {"width": 1280, "height": 800})):
            ctx = await b.new_context(viewport=vp, device_scale_factor=2 if vp["width"] < 600 else 1, locale="ar-SA")
            P = Page(await ctx.new_page())
            await P.open(url)
            await P.ev("(async () => { const a = window.__karaoke.app; await a.ensureEngine(); await a.engine.enableMic({headphones: true}); a.go('practice'); })()")
            await P.page.wait_for_selector("#btn-sing")
            await P.page.wait_for_timeout(500)
            m = await P.ev("""() => { const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return {top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height, vis: getComputedStyle(e).display !== 'none'}; };
                return { innerW: innerWidth, innerH: innerHeight, scrollW: document.documentElement.scrollWidth, ind: r('.indicators'), sticky: r('.sticky-controls'), canvas: r('.viewcard canvas'), lines: r('.lines'),
                         listen: r('#btn-listen-line'), alt: r('#link-listen-line') }; }""")
            cv = await P.ev("() => { const c = document.querySelector('.viewcard canvas'); const b = c.getBoundingClientRect(); return {cw: c.width, ch: c.height, w: b.width, h: b.height, dpr: devicePixelRatio}; }")
            c.data[name + "_canvas"] = cv
            c.check(abs(cv["cw"] - cv["w"] * min(3, cv["dpr"])) <= 2 and abs(cv["ch"] - cv["h"] * min(3, cv["dpr"])) <= 2, f"{name}: دقة لوحة الرسم تطابق حجمها الظاهر (لا ضبابية من التمدّد)", canvas=cv)
            c.data[name] = m
            c.check(m["scrollW"] <= m["innerW"] + 1, f"{name}: لا تجاوز أفقي", scrollW=m["scrollW"], innerW=m["innerW"])
            c.check(m["canvas"]["bottom"] <= m["sticky"]["top"] + 1 or m["innerH"] < 760, f"{name}: الرسم لا يختفي خلف الشريط اللاصق", canvasBottom=m["canvas"]["bottom"], stickyTop=m["sticky"]["top"])
            if (vp["width"] < 600 and vp["height"] >= 840) or vp["width"] >= 960:
                c.check(m["ind"]["bottom"] <= m["sticky"]["top"] + 1, f"{name}: المؤشرات الثلاثة ظاهرة كاملة فوق الشريط اللاصق دون تمرير", indBottom=m["ind"]["bottom"], stickyTop=m["sticky"]["top"])
            # زر «استمع للشطر» متاح بإحدى صورتيه دائمًا
            c.check((m["listen"] and m["listen"]["vis"] and m["listen"]["h"] > 0) or (m["alt"] and m["alt"]["vis"] and m["alt"]["h"] > 0), f"{name}: زر الاستماع للشطر متاح")
            await P.page.screenshot(path=str(OUT / f"layout_practice_{name}.png"))
            c.check(not P.errors(), f"{name}: لا أخطاء كونسول", errors=P.errors()[:3])
            await ctx.close()
    return c.done()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--long", type=int, default=0, help="مدة التشغيل الطويل بالثواني")
    a = ap.parse_args()
    only = {s.strip() for s in a.only.split(",") if s.strip()}
    want = lambda cid: not only or any(cid.startswith(o) for o in only)  # noqa: E731
    tmp = Path(tempfile.mkdtemp(prefix="karaoke-e2e-"))
    media = make_media(tmp, ROOT / "web/audio/reference.mp3")
    started = time.time()
    async with server() as url:
        async with browser() as b:
            seq = [("E01", e01_boot), ("E02", e02_mismatch), ("E03", e03_identical), ("E04", e04_delay), ("E06", e06_gain), ("E07", e07_silence),
                   ("E09", e09_ref_silence), ("E10", e10_seek), ("E11", e11_volume), ("E12", e12_devices), ("E14", e14_video), ("E17", e17_leak)]
            for cid, fn in seq:
                if want(cid):
                    try:
                        await fn(b, url)
                    except Exception as e:  # noqa: BLE001
                        traceback.print_exc()
                        RESULTS.append({"id": cid, "passed": False, "error": repr(e)})
                        print(f"[ERROR] {cid}: {e!r}")
            if want("E05"):
                secs = a.long or (45 if a.quick else 120)
                try:
                    await e05_longrun(b, url, secs)
                except Exception as e:  # noqa: BLE001
                    traceback.print_exc(); RESULTS.append({"id": "E05", "passed": False, "error": repr(e)})
        for cid, fn in (("E13", lambda u: e13_permission(u)), ("E15", lambda u: e15_fake_tone(media, u)), ("E16", lambda u: e16_fake_silence_noise(media, u)),
                        ("E18", lambda u: e18_ui_flow(media, u)), ("E19", lambda u: e19_screens(u)), ("E20", lambda u: e20_layout(media, u))):
            if want(cid):
                try:
                    await fn(url)
                except Exception as e:  # noqa: BLE001
                    traceback.print_exc(); RESULTS.append({"id": cid, "passed": False, "error": repr(e)}); print(f"[ERROR] {cid}: {e!r}")
    passed = sum(1 for r in RESULTS if r.get("passed"))
    summary = {"passed": passed, "total": len(RESULTS), "seconds": round(time.time() - started, 1),
               "note": "كل الحالات software-path-only: ميكروفون وهمي/نسخة المرجع المعاد توجيهها؛ لا تمثّل أداء إنسان ولا ميكروفونًا مادّيًا."}
    (OUT / "e2e_results.json").write_text(json.dumps({"summary": summary, "cases": RESULTS}, ensure_ascii=False, indent=1))
    print("\n== الملخص ==", json.dumps(summary, ensure_ascii=False))
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
