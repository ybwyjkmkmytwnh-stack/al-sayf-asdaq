// اتساق «المقدّر الحي (JS/YIN سببي على معدل 44.1k)» مع «التحليل المسبق (Python/pYIN على 16k)» على التسجيل الحقيقي،
// وكاشف البدايات JS مقابل أحداث البدايات في ملف التحليل. إن لم يتوفر ffmpeg يُتخطّى الاختبار.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { FrameAnalyzer } from '../../web/js/core/frames.js';
import { detectOnsets } from '../../web/js/core/score.js';
import { loadRef, ROOT } from './helpers.js';

const ff = spawnSync('ffmpeg', ['-version']);
const HAVE_FFMPEG = ff.status === 0;
const ref = loadRef();
const CTX = 44100, T0 = 20, T1 = 80;

function decodeSlice() {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', path.join(ROOT, 'web/audio/reference.mp3'), '-ac', '1', '-ar', String(CTX),
    '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 30 });
  const buf = r.stdout;
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  return all.slice(T0 * CTX, T1 * CTX);
}

test('المقدّر الحي على 44.1kHz يطابق pYIN المسبق: فرق الطبقة بالسنت والطاقة بالديسيبل وزمن الإطار', { skip: !HAVE_FFMPEG && 'ffmpeg غير متوفر', timeout: 120000 }, () => {
  const x = decodeSlice();
  const fa = new FrameAnalyzer({ ctxRate: CTX });
  fa.reset(T0 * CTX);                          // tCtx = زمن المرجع مباشرة
  const frames = [];
  for (let p = 0; p < x.length; p += 1024) frames.push(...fa.push(x.subarray(p, p + 1024)));
  let nBoth = 0, big = 0, nVoicedLive = 0, nVoicedRef = 0, usable = 0;
  const dc = [], de = [];
  for (const f of frames) {
    const i = ref.idx(f.tCtx);
    if (i < 0 || i >= ref.n) continue;
    de.push(Math.abs(f.energyDb - ref.energyDb[i]));
    const rv = ref.usablePitch(i);
    if (rv) usable++;
    if (f.voiced) nVoicedLive++;
    if (rv && f.voiced) {
      nBoth++;
      const d = Math.abs(1200 * Math.log2(f.f0 / ref.f0[i]));
      dc.push(d);
      if (d > 100) big++;
    }
    if (rv) nVoicedRef++;
  }
  dc.sort((a, b) => a - b); de.sort((a, b) => a - b);
  const stat = {
    frames: frames.length, medianAbsCents: dc[dc.length >> 1], p90AbsCents: dc[Math.floor(dc.length * 0.9)], grossFrac: big / nBoth,
    coverageOfRefVoiced: nBoth / usable, medianAbsDb: de[de.length >> 1], p90AbsDb: de[Math.floor(de.length * 0.9)],
  };
  console.log('# crosscheck live-vs-offline:', JSON.stringify(stat));
  assert.ok(stat.medianAbsCents < 12, `median |Δ| = ${stat.medianAbsCents}`);
  assert.ok(stat.grossFrac < 0.08, `gross (>100c) = ${stat.grossFrac}`);
  assert.ok(stat.coverageOfRefVoiced > 0.80, `live voiced on ref voiced = ${stat.coverageOfRefVoiced}`);
  assert.ok(stat.medianAbsDb < 1.0, `energy Δ = ${stat.medianAbsDb}`);
});

test('كاشف البدايات في JS يعيد ≥90% من أحداث البدايات المحفوظة (اتساق المنفّذين Python/JS)', () => {
  const lo = ref.idx(T0), hi = ref.idx(T1);
  const js = detectOnsets(ref.energyDb, ref.voiced, ref.hop, lo, hi, { riseDb: 8, withinSec: 0.08 }).map((o) => o.i * ref.hop);
  const py = ref.onsets.filter((o) => o.timeSec >= T0 + 0.1 && o.timeSec < T1 - 0.1).map((o) => o.timeSec);
  let hit = 0;
  for (const t of py) if (js.some((q) => Math.abs(q - t) <= 0.02)) hit++;
  console.log('# onset detector agreement:', hit, '/', py.length);
  assert.ok(hit / py.length >= 0.9, `${hit}/${py.length}`);
});
