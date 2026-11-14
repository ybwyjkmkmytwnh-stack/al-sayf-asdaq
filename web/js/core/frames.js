// محلّل إطارات متدفق: عينات بمعدل السياق → إطارات (طبقة/دورية/طاقة) كل hopSec على شبكة زمن السياق.
//
// اصطلاحات (موثّقة وتُختبر):
//  • مركز الإطار k في زمن السياق: tCtx = k * hopSec (شبكة مطلقة مشتركة بين كل المحلّلات، فيتطابق ميكروفون/مرجع).
//  • يُجرى التحليل بعد خفض المعدل بعامل صحيح D = floor(ctxRate / 16000): 44100→22050، 48000→16000.
//  • تأخير مجموعة مرشّح الخفض يُعوَّض في حساب فهرس العينة (delay = (taps−1)/2 عينة دخل).
//  • «تأخير التحليل»: لإطار مركزه c نحتاج عينات حتى c + L/2 (L = W+τmax+1)، أي أن الإطار يصير متاحًا بعد
//    ≈ L/(2·sr) ثانية من مركزه (28–40 ms). لا يؤثر هذا على ختم الزمن (الختم بالمركز) لكنه يؤثر على العرض الحي فقط.
import { Decimator, windowEnergyDb } from './dsp.js';
import { YinEstimator, yinGeometry } from './yin.js';

export class FrameAnalyzer {
  constructor(opts) {
    this.ctxRate = opts.ctxRate;
    this.hopSec = opts.hopSec ?? 0.01;
    this.targetRate = opts.targetRate ?? 16000;
    this.D = Math.max(1, Math.floor(this.ctxRate / this.targetRate));
    this.sr = this.ctxRate / this.D;
    this.voicedPeriodicity = opts.voicedPeriodicity ?? 0.5;
    this.energyGateDb = opts.energyGateDb ?? -65;
    this.taps = opts.taps ?? 63;
    this.yin = new YinEstimator(this.sr, {
      windowSec: opts.windowSec ?? 0.04, fmin: opts.fmin ?? 65, fmax: opts.fmax ?? 800,
      threshold: opts.threshold ?? 0.2,
    });
    this.g = this.yin.g;
    this.hopCtx = this.hopSec * this.ctxRate;
    this.dec = new Decimator(this.D, this.taps);
    this.reset(0);
  }

  /** firstCtxFrame: فهرس إطار السياق (currentFrame) لأول عينة ستُدفع بعد هذا الاستدعاء. يمسح كل الحالة. */
  reset(firstCtxFrame) {
    this.dec.reset();
    this.base = firstCtxFrame;
    this.buf = new Float32Array(this.g.L * 8);
    this.bufStart = 0;   // فهرس (مخفَّض) لأول عنصر في buf
    this.bufLen = 0;     // عدد العينات الصالحة في buf
    this.warmup = Math.ceil(this.taps / this.D) + 2; // خرج المرشّح قبله متأثر بالحالة الصفرية
    // أول إطار ممكن: مركزه ≥ ما يضمن start ≥ warmup
    const minCenterDec = this.warmup + Math.floor(this.g.L / 2);
    const minCenterCtx = this.base + minCenterDec * this.D - this.dec.delay;
    this.nextK = Math.ceil(minCenterCtx / this.hopCtx);
  }

  /** x: Float32Array بمعدل السياق. يعيد مصفوفة إطارات جاهزة. */
  push(x) {
    const { out } = this.dec.process(x);
    if (out.length) this._append(out);
    const frames = [];
    const { L, W } = this.g;
    const halfL = Math.floor(L / 2), halfW = Math.floor(W / 2);
    for (;;) {
      const fc = this.nextK * this.hopCtx;                       // مركز الإطار بإطارات السياق
      const mc = (fc - this.base + this.dec.delay) / this.D;     // مركزه في الفهرس المخفَّض
      const mcR = Math.round(mc);
      const start = mcR - halfL;
      if (start + L > this.bufStart + this.bufLen) break;        // لم تتوفر العينات بعد
      const off = start - this.bufStart;
      const est = this.yin.estimate(this.buf, off);
      const eOff = mcR - halfW - this.bufStart;
      const energyDb = windowEnergyDb(this.buf, eOff, W);
      const f0 = est.f0;
      const voiced = Number.isFinite(f0) && est.periodicity >= this.voicedPeriodicity && energyDb >= this.energyGateDb;
      frames.push({
        k: this.nextK, tCtx: fc / this.ctxRate, ctxFrame: fc,
        f0: Number.isFinite(f0) ? f0 : NaN, periodicity: est.periodicity, energyDb, voiced,
      });
      this.nextK++;
    }
    this._trim(this.nextK);
    return frames;
  }

  _append(out) {
    const need = this.bufLen + out.length;
    if (need > this.buf.length) {
      const nb = new Float32Array(Math.max(this.buf.length * 2, need));
      nb.set(this.buf.subarray(0, this.bufLen));
      this.buf = nb;
    }
    this.buf.set(out, this.bufLen);
    this.bufLen += out.length;
  }

  _trim(k) {
    const fc = k * this.hopCtx;
    const mc = Math.round((fc - this.base + this.dec.delay) / this.D);
    const keepFrom = mc - Math.floor(this.g.L / 2) - 2;
    const drop = keepFrom - this.bufStart;
    if (drop > this.g.L * 4) {
      this.buf.copyWithin(0, drop, this.bufLen);
      this.bufLen -= drop;
      this.bufStart += drop;
    }
  }
}

export { yinGeometry };
