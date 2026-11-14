import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameAnalyzer } from '../../web/js/core/frames.js';

function harmonic(fn, sr, dur, amp = 0.3) {
  const x = new Float32Array(Math.round(dur * sr));
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    ph += (2 * Math.PI * fn(i / sr)) / sr;
    let v = 0;
    for (let h = 1; h <= 5; h++) v += Math.sin(h * ph) / h;
    x[i] = (amp * v) / 2;
  }
  return x;
}
function run(fa, x, chunk) {
  const out = [];
  for (let p = 0; p < x.length; p += chunk) out.push(...fa.push(x.subarray(p, Math.min(x.length, p + chunk))));
  return out;
}

test('معدلات السياق: خفض صحيح (44.1k→22.05k، 48k→16k) ودقة طبقة بالسنت', () => {
  for (const [sr, D] of [[44100, 2], [48000, 3], [16000, 1], [32000, 2]]) {
    const fa = new FrameAnalyzer({ ctxRate: sr });
    assert.equal(fa.D, D, `D لمعدل ${sr}`);
    const fr = run(fa, harmonic(() => 180, sr, 2.0), 1024);
    const good = fr.filter((f) => f.tCtx > 0.2 && f.tCtx < 1.7);
    assert.ok(good.filter((f) => f.voiced).length >= good.length - 1, `voiced لمعدل ${sr}`);
    for (const f of good) assert.ok(Math.abs(1200 * Math.log2(f.f0 / 180)) < 3, `sr=${sr} t=${f.tCtx}`);
  }
});

test('شبكة الإطارات: خطوة 10ms ثابتة ومشتركة بين المحلّلات (tCtx = k*hop)', () => {
  const a = new FrameAnalyzer({ ctxRate: 44100 }), b = new FrameAnalyzer({ ctxRate: 44100 });
  const x = harmonic(() => 200, 44100, 1.0);
  const fa = run(a, x, 128), fb = run(b, x, 1000);
  assert.equal(fa.length, fb.length);
  for (let i = 0; i < fa.length; i++) {
    assert.ok(Math.abs(fa[i].tCtx - fb[i].tCtx) < 1e-12);
    assert.ok(Math.abs(fa[i].tCtx - fa[i].k * 0.01) < 1e-9);
    assert.ok(Math.abs(fa[i].f0 - fb[i].f0) < 1e-3 || (Number.isNaN(fa[i].f0) && Number.isNaN(fb[i].f0)), 'استقلال عن حجم الدفعة');
  }
});

test('زمن الإطار: انفجار طاقة يبدأ عند 0.500 ث يظهر مركز ارتفاعه ضمن ±10ms (اصطلاح المركز)', () => {
  const sr = 48000;
  const x = new Float32Array(sr * 1);
  for (let i = Math.round(0.5 * sr); i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 200 * i) / sr);
  const fr = run(new FrameAnalyzer({ ctxRate: sr }), x, 512);
  // نافذة الطاقة 40ms مركزية: الإطار الذي مركزه 0.5 ث يحوي نصف نافذته طاقة ⇒ طاقته ≈ −3 dB عن الكاملة
  const full = fr.find((f) => f.tCtx > 0.8).energyDb;
  const half = fr.reduce((b, f) => (Math.abs(f.tCtx - 0.5) < Math.abs(b.tCtx - 0.5) ? f : b));
  assert.ok(Math.abs(half.energyDb - (full - 3.01)) < 0.8, `half=${half.energyDb} full=${full}`);
});

test('reset يمسح الحالة: لا إطارات من قبل reset ولا خلط', () => {
  const sr = 44100, fa = new FrameAnalyzer({ ctxRate: sr });
  const x = harmonic(() => 220, sr, 1.0);
  run(fa, x, 441);
  fa.reset(sr * 5);                       // مقطع جديد يبدأ عند إطار السياق 5 ث
  const y = harmonic(() => 150, sr, 1.0);
  const fr = run(fa, y, 441);
  assert.ok(fr.length > 60);
  assert.ok(fr[0].tCtx >= 5.0, 'أول إطار بعد reset لا يسبق نقطة البدء');
  for (const f of fr.filter((q) => q.tCtx > 5.15)) assert.ok(Math.abs(1200 * Math.log2(f.f0 / 150)) < 3);
});

test('صمت/ضجيج: لا طبقة مختلَقة', () => {
  const sr = 44100;
  const sil = run(new FrameAnalyzer({ ctxRate: sr }), new Float32Array(sr), 441);
  assert.ok(sil.every((f) => !f.voiced && Number.isNaN(f.f0)));
  let s = 7; const noise = Float32Array.from({ length: sr * 2 }, () => 0.1 * (((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5) * 2);
  const nf = run(new FrameAnalyzer({ ctxRate: sr }), noise, 441);
  assert.ok(nf.filter((f) => f.voiced).length / nf.length < 0.1);
});
