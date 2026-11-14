// محرّر توقيت الشطر على منحنى الطاقة (من التحليل المسبق) مع مقبضين قابلين للسحب لبداية/نهاية الشطر.
// الحالة تُعرض دائمًا: تلقائي (تقديري) / مصحَّح يدويًا / ضعيف الثقة. لا يغيّر الملف المرجعي: التصحيحات تُحفظ محليًا وتُصدَّر.
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export class TimingEditor {
  constructor(canvas, { ref, hem, prefs, onChange }) {
    Object.assign(this, { canvas, ref, prefs, onChange });
    this.g = canvas.getContext('2d');
    this.hem = hem;
    this.start = hem.startSec; this.end = hem.endSec;
    this.playhead = null;
    this.margin = 4.5;
    this.drag = null;
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    this._onResize = () => this.resize(); window.addEventListener('resize', this._onResize);
    this.resize();
  }
  dispose() { window.removeEventListener('resize', this._onResize); }
  get t0() { return Math.max(0, this.hem.startSec - this.margin); }
  get t1() { return Math.min(this.ref.a.durationSec, this.hem.endSec + this.margin); }
  resize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1), r = this.canvas.getBoundingClientRect();
    this.W = Math.max(200, r.width); this.H = Math.max(120, r.height);
    this.canvas.width = Math.round(this.W * dpr); this.canvas.height = Math.round(this.H * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0); this.draw();
  }
  x(t) { const pad = 12, u = (t - this.t0) / (this.t1 - this.t0), w = this.W - 2 * pad; return this.prefs.timeDir === 'ltr' ? pad + u * w : this.W - pad - u * w; }
  tAt(x) { const pad = 12, w = this.W - 2 * pad; const u = this.prefs.timeDir === 'ltr' ? (x - pad) / w : (this.W - pad - x) / w; return this.t0 + u * (this.t1 - this.t0); }
  setBounds(s, e) { this.start = s; this.end = e; this.draw(); }
  setPlayhead(t) { this.playhead = t; this.draw(); }
  draw() {
    const g = this.g, ref = this.ref, ink = css('--text-2'), refC = css('--ref'), acc = css('--accent'), grid = css('--grid');
    g.clearRect(0, 0, this.W, this.H);
    // الطاقة (dB) كمساحة
    const yE = (db) => this.H - 14 - ((Math.max(-60, Math.min(0, db)) + 60) / 60) * (this.H - 28);
    const i0 = Math.max(0, ref.idx(this.t0)), i1 = Math.min(ref.n - 1, ref.idx(this.t1));
    g.beginPath(); g.moveTo(this.x(ref.time(i0)), this.H - 14);
    for (let i = i0; i <= i1; i += 2) g.lineTo(this.x(ref.time(i)), yE(ref.energyDb[i]));
    g.lineTo(this.x(ref.time(i1)), this.H - 14); g.closePath();
    g.fillStyle = css('--ref-soft'); g.fill();
    // الطبقة (خط)
    g.strokeStyle = refC; g.lineWidth = 2; g.beginPath(); let pen = false;
    const cl = ref.a.stats.f0Hz; const lo = 1200 * Math.log2(cl.p5 / 100) - 100, hi = 1200 * Math.log2(cl.p95 / 100) + 100;
    for (let i = i0; i <= i1; i++) {
      if (!ref.usablePitch(i)) { pen = false; continue; }
      const yy = this.H - 14 - ((ref.cents[i] - lo) / (hi - lo)) * (this.H - 28);
      const xx = this.x(ref.time(i)); if (!pen) { g.moveTo(xx, yy); pen = true; } else g.lineTo(xx, yy);
    }
    g.stroke();
    // وقفات
    g.fillStyle = grid; for (const p of ref.pauses) if (p.endSec > this.t0 && p.startSec < this.t1) { const a = this.x(p.startSec), b = this.x(p.endSec); g.fillRect(Math.min(a, b), 0, Math.max(2, Math.abs(b - a)), 8); }
    // الشطر المحدّد
    const xa = this.x(this.start), xb = this.x(this.end);
    g.fillStyle = css('--accent-soft'); g.fillRect(Math.min(xa, xb), 0, Math.abs(xb - xa), this.H);
    for (const [xx, lab] of [[xa, 'بداية'], [xb, 'نهاية']]) {
      g.strokeStyle = acc; g.lineWidth = 3; g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, this.H); g.stroke();
      g.fillStyle = acc; g.beginPath(); g.arc(xx, this.H / 2, 11, 0, 6.2832); g.fill();
      g.fillStyle = '#fff'; g.font = '700 11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(lab === 'بداية' ? 'ب' : 'ن', xx, this.H / 2 + 1);
    }
    if (this.playhead != null) { const xp = this.x(this.playhead); g.strokeStyle = ink; g.lineWidth = 2; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(xp, 0); g.lineTo(xp, this.H); g.stroke(); g.setLineDash([]); }
  }
  _hit(e) {
    const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left;
    const da = Math.abs(x - this.x(this.start)), db = Math.abs(x - this.x(this.end));
    if (Math.min(da, db) > 22) return null;
    return da <= db ? 'start' : 'end';
  }
  _down(e) { const k = this._hit(e); if (!k) return; this.drag = k; this.canvas.setPointerCapture(e.pointerId); e.preventDefault(); }
  _move(e) {
    if (!this.drag) return;
    const r = this.canvas.getBoundingClientRect();
    const t = Math.round(this.tAt(e.clientX - r.left) * 100) / 100;
    this.nudgeTo(this.drag, t, false);
  }
  _up() { if (this.drag) { this.drag = null; this.onChange?.(this.start, this.end); } }
  nudgeTo(which, t, commit = true) {
    const minDur = 0.3;
    if (which === 'start') this.start = Math.max(this.t0, Math.min(t, this.end - minDur));
    else this.end = Math.min(this.t1, Math.max(t, this.start + minDur));
    this.draw();
    if (commit) this.onChange?.(this.start, this.end);
  }
}
