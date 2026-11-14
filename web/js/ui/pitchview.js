// عرض الطبقة على لوحة canvas: مسار المرجع (هادئ ولون ثابت) + نقاط المستخدم على المحور الزمني نفسه.
//
// الاتجاه الزمني ثابت وصريح (لا يتبع dir للصفحة تلقائيًا):
//   timeDir='rtl' : الزمن يتقدّم نحو اليسار (المستقبل يسار الرأس) — يوافق اتجاه قراءة الشعر العربي.
//   timeDir='ltr' : الزمن يتقدّم نحو اليمين.
// المحور الرأسي لوغاريتمي (سنت)، بخطوط شبكة كل نصف نغمة، ومركزه وسيط المرجع بعد إزاحة الراحة الثابتة.
// الألوان ليست وحدها حاملة المعنى: النقاط الخضراء دوائر، الصفراء مربعات صغيرة، الحمراء معينات (أشكال مختلفة).
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export class PitchView {
  constructor(canvas, { ref, engine, getHem, prefs }) {
    Object.assign(this, { canvas, ref, engine, getHem, prefs });
    this.ctx2d = canvas.getContext('2d');
    this.past = 2.4; this.future = 5.6;
    const st = ref.a.stats;
    this.cLo = 1200 * Math.log2(st.f0Hz.p5 / 100) - 260;
    this.cHi = 1200 * Math.log2(st.f0Hz.p95 / 100) + 260;
    this.raf = null; this.lastDraw = 0; this.tStatic = null;
    this.refSmooth = this._smoothRef();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    // الحجم الفعلي يُعرف بعد إلحاق اللوحة بالصفحة: نراقب تغيّره (وإلا تُرسم بدقة 200×120 وتُمدَّد فتبدو ضبابية)
    if (typeof ResizeObserver !== 'undefined') { this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(canvas); }
    this.resize();
  }
  /** مسار مرجعي «هادئ» للعرض فقط: وسيط 7 إطارات على الإطارات الصالحة (التقييم لا يستعمل هذا التنعيم). */
  _smoothRef() {
    const ref = this.ref, n = ref.n, out = new Float32Array(n).fill(NaN), win = [];
    for (let i = 0; i < n; i++) {
      if (!ref.usablePitch(i)) continue;
      win.length = 0;
      for (let k = i - 3; k <= i + 3; k++) if (k >= 0 && k < n && ref.usablePitch(k)) win.push(ref.cents[k]);
      win.sort((a, b) => a - b);
      out[i] = win[win.length >> 1];
    }
    return out;
  }
  resize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(200, r.width), hh = Math.max(90, r.height);
    if (this.W === w && this.H === hh && this._dpr === dpr) return;   // لا إعادة تخصيص بلا تغيّر (تجنّب وميض)
    this.W = w; this.H = hh; this._dpr = dpr;
    this.canvas.width = Math.round(this.W * dpr); this.canvas.height = Math.round(this.H * dpr);
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  start(reduced = false) { this.stop(); this.reduced = reduced; const loop = (ts) => { if (ts - this.lastDraw >= (this.reduced ? 100 : 30)) { this.lastDraw = ts; this.draw(); } this.raf = requestAnimationFrame(loop); }; this.raf = requestAnimationFrame(loop); }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }
  dispose() { this.stop(); window.removeEventListener('resize', this._onResize); this._ro?.disconnect(); }
  setStaticTime(t) { this.tStatic = t; this.draw(); }

  x(t, t0) {
    const pad = 10, w = this.W - 2 * pad, u = (t - t0) / (this.past + this.future);
    return this.prefs.timeDir === 'ltr' ? pad + u * w : this.W - pad - u * w;
  }
  y(c) { const pad = 12; return this.H - pad - ((c - this.cLo) / (this.cHi - this.cLo)) * (this.H - 2 * pad); }

  draw() {
    const g = this.ctx2d, ref = this.ref, eng = this.engine;
    const playing = eng?.state === 'playing';
    const tNow = playing ? eng.currentRefTime() : (this.tStatic ?? this.getHem?.()?.startSec ?? 0);
    const t0 = tNow - this.past, t1 = tNow + this.future;
    const off = eng?.calibration?.offsetCents || 0;
    const ink = css('--text-2'), grid = css('--grid'), refC = css('--ref'), refSoft = css('--ref-soft'), ok = css('--ok'), warn = css('--warn'), bad = css('--bad'), none = css('--none');
    g.clearRect(0, 0, this.W, this.H);
    // مناطق مرجعية غير موثوقة (مستبعدة من التقييم): تظليل رمادي
    g.fillStyle = refSoft;
    for (const r of ref.a.segments.regions) {
      if (r.type !== 'unreliable' || r.endSec < t0 || r.startSec > t1) continue;
      const xa = this.x(r.startSec, t0), xb = this.x(r.endSec, t0);
      g.globalAlpha = 0.5; g.fillRect(Math.min(xa, xb), 0, Math.abs(xb - xa), this.H); g.globalAlpha = 1;
    }
    // خطوط نصف النغمة
    g.lineWidth = 1; g.strokeStyle = grid;
    const base = Math.ceil((this.cLo - off) / 100) * 100;
    for (let c = base; c <= this.cHi - off + 100; c += 100) { const yy = this.y(c + off); if (yy < 0 || yy > this.H) continue; g.beginPath(); g.moveTo(0, yy); g.lineTo(this.W, yy); g.stroke(); }
    // وقفات المرجع
    g.fillStyle = grid;
    for (const p of ref.pauses) {
      if (p.endSec < t0 || p.startSec > t1) continue;
      const xa = this.x(p.startSec, t0), xb = this.x(p.endSec, t0);
      g.fillRect(Math.min(xa, xb), this.H - 8, Math.max(2, Math.abs(xb - xa)), 6);
    }
    // مسار المرجع (بعد إزاحة الراحة)
    g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = 4.5; g.strokeStyle = refC;
    const i0 = Math.max(0, ref.idx(t0)), i1 = Math.min(ref.n - 1, ref.idx(t1));
    let pen = false, prevC = NaN;
    const step = Math.max(1, Math.round(this.W > 500 ? 1 : 2));
    g.globalAlpha = 0.6; g.beginPath();
    for (let i = i0; i <= i1; i += step) {
      const c = this.refSmooth[i];
      if (!(c === c)) { pen = false; continue; }
      const xx = this.x(ref.time(i), t0), yy = this.y(c + off);
      // قفزة كبيرة بين إطارين متجاورين = انقطاع في المسار لا خط عمودي (مسار هادئ)
      if (pen && Math.abs(c - prevC) > 350) pen = false;
      if (!pen) { g.moveTo(xx, yy); pen = true; } else g.lineTo(xx, yy);
      prevC = c;
    }
    g.stroke(); g.globalAlpha = 1;
    // الرأس (الآن)
    const xn = this.x(tNow, t0);
    g.strokeStyle = ink; g.lineWidth = 2; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(xn, 0); g.lineTo(xn, this.H); g.stroke(); g.setLineDash([]);
    // نقاط المستخدم
    const seg = eng?.seg;
    if (eng?.micOn && seg && seg.tracker.count && playing) {
      const user = eng.session.userTrack(eng.latency.snapshot(), { tStart: t0, tEnd: tNow + 0.05, segmentIds: [seg.id] });
      const n = user.t.length;
      const smooth = [];
      for (let j = 0; j < n; j++) {
        if (!user.measurable[j] || !user.voiced[j] || !(user.periodicity[j] >= 0.5) || !Number.isFinite(user.f0[j]) || user.t[j] < t0 || user.t[j] > tNow + 0.05) continue;
        smooth.push([user.t[j], 1200 * Math.log2(user.f0[j] / 100)]);
      }
      // وسيط 5 لإزالة قفزات إطار واحد من العرض فقط (التقييم يستعمل أنقى منه)
      for (let j = 0; j < smooth.length; j++) {
        const a = smooth.slice(Math.max(0, j - 2), j + 3).map((p) => p[1]).sort((p, q) => p - q);
        const c = a[a.length >> 1];
        const ri = ref.idx(smooth[j][0]);
        let col = none, shape = 'c';
        if (ri >= 0 && ri < ref.n && ref.usablePitch(ri)) {
          const e = Math.abs(c - ref.cents[ri] - off);
          if (e <= 50) { col = ok; shape = 'c'; } else if (e <= 100) { col = warn; shape = 's'; } else { col = bad; shape = 'd'; }
        }
        const xx = this.x(smooth[j][0], t0), yy = this.y(c);
        if (yy < -10 || yy > this.H + 10) { g.fillStyle = bad; g.fillRect(xx - 3, yy < 0 ? 1 : this.H - 5, 6, 4); continue; }
        g.fillStyle = col;
        if (shape === 'c') { g.beginPath(); g.arc(xx, yy, 3.2, 0, 6.2832); g.fill(); }
        else if (shape === 's') g.fillRect(xx - 3, yy - 3, 6, 6);
        else { g.beginPath(); g.moveTo(xx, yy - 4.2); g.lineTo(xx + 4.2, yy); g.lineTo(xx, yy + 4.2); g.lineTo(xx - 4.2, yy); g.closePath(); g.fill(); }
      }
    }
    // إطار الشطر الحالي (حدود تقديرية)
    const hem = this.getHem?.();
    if (hem) {
      g.strokeStyle = refC; g.lineWidth = 2; g.globalAlpha = 0.6;
      for (const t of [hem.startSec, hem.endSec]) { const xx = this.x(t, t0); if (xx > 0 && xx < this.W) { g.setLineDash(hem.status === 'manual' ? [] : [2, 5]); g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, this.H); g.stroke(); } }
      g.setLineDash([]); g.globalAlpha = 1;
    }
  }
}
