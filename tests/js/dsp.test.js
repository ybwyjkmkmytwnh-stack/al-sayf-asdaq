import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimator, normalizedXcorr, fft, median, percentile, windowEnergyDb } from '../../web/js/core/dsp.js';

test('Decimator: كسب DC=1 وتخميد ما فوق Nyquist الجديد، والاستمرارية عبر الدفعات', () => {
  const D = 3;
  const sr = 48000, n = 48000;
  const dc = new Float32Array(n).fill(0.5);
  const d = new Decimator(D);
  const r = d.process(dc);
  assert.ok(Math.abs(r.out[200] - 0.5) < 1e-4);
  // نغمة 1 kHz تمرّ، نغمة 12 kHz (> Nyquist الجديد 8k) تُخمَّد جدًا
  const tone = (f) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / sr));
  const rms = (x) => Math.sqrt(x.slice(100).reduce((s, v) => s + v * v, 0) / (x.length - 100));
  assert.ok(rms(new Decimator(D).process(tone(1000)).out) > 0.68);
  assert.ok(rms(new Decimator(D).process(tone(12000)).out) < 0.02);
  // نفس الخرج بدفعات مختلفة
  const x = tone(440);
  const a = new Decimator(D).process(x).out;
  const dd = new Decimator(D);
  const parts = [];
  for (let p = 0; p < x.length; p += 1000 + (p % 7)) parts.push(...dd.process(x.subarray(p, p + 1000 + (p % 7))).out);
  const m = Math.min(a.length, parts.length);
  for (let i = 0; i < m; i++) assert.ok(Math.abs(a[i] - parts[i]) < 1e-6, `i=${i}`);
});

test('normalizedXcorr: يكتشف تأخير b عن a بدقة عينة', () => {
  const rng = (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5; })();
  const a = Float32Array.from({ length: 8000 }, rng);
  const lag = 313;
  const b = new Float32Array(8000);
  for (let i = lag; i < 8000; i++) b[i] = 0.5 * a[i - lag];
  const r = normalizedXcorr(a, b, 1000);
  assert.equal(r.bestLag, lag);
  assert.ok(r.bestCorr > 0.9);
});

test('fft ثم معكوسها يعيد الإشارة', () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + i * 0.01), im = new Float64Array(64);
  const orig = Float64Array.from(re);
  fft(re, im); fft(re, im, true);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
});

test('إحصاءات: median/percentile وطاقة النافذة', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(percentile([0, 10, 20, 30, 40], 50), 20);
  const x = new Float32Array(100).fill(0.1);
  assert.ok(Math.abs(windowEnergyDb(x, 0, 100) - (-20)) < 1e-6);
  assert.equal(windowEnergyDb(new Float32Array(10), 0, 10), -120);
});
