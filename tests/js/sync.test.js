// 3) تأخير معروف: كشف وتعويض بالإشارة الصحيحة · 9) لا خلط بعد seek · 12) لا انجراف في تشغيل طويل
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreWindow } from '../../web/js/core/score.js';
import { LatencyModel, refTimeForMic, alignTapToReference, DeltaTracker, SIGN_CONVENTION_AR } from '../../web/js/core/sync.js';
import { Session } from '../../web/js/core/session.js';
import { loadRef, userFromRef, CAL, W } from './helpers.js';

const ref = loadRef();
const DELTA = 7.123; // δ اعتباطي بين زمن السياق وزمن المرجع

/** يبني مستخدمًا «يغنّي بتزامن تام مع ما يسمعه» لكن إطارات ميكروفونه تصل متأخرة بمقدار actualLatency ثم يُعوَّض بـ declared. */
function userViaDevice(actual, declared, { early = 0 } = {}) {
  const base = userFromRef(ref, { ...W, delaySec: -early });
  const lat = new LatencyModel({ inputLatency: declared.inputSec ?? 0, outputLatency: declared.outputSec ?? 0, manualSec: declared.manualSec ?? 0 });
  const t = new Float64Array(base.t.length);
  for (let i = 0; i < t.length; i++) {
    const tCtx = base.t[i] + DELTA + actual;                 // وصول العينة في السياق (الفعلي)
    t[i] = refTimeForMic(tCtx, DELTA, lat.snapshot());       // ما يحسبه التطبيق
  }
  return { ...base, t };
}
const run = (u, mode) => scoreWindow(ref, u, { ...W, mode, calibration: CAL });

test('3) تأخير جهاز معروف 250ms: عند التصريح به (إدخال/إخراج/يدوي) يتحقق التطابق', () => {
  for (const decl of [{ outputSec: 0.15, inputSec: 0.10 }, { outputSec: 0.25 }, { manualSec: 0.25 }]) {
    const r = run(userViaDevice(0.25, decl), 'strict');
    assert.ok(r.overall > 0.95, `declared ${JSON.stringify(decl)} → ${r.overall}`);
  }
});

test('3b) بلا تصريح بالتأخير: الوضع الصارم يعاقب، والمتسامح يكشف الإزاحة (+ = المستخدم متأخر) ويُبقي خطأ التوقيت ظاهرًا', () => {
  const late = userViaDevice(0.25, {});
  const strict = run(late, 'strict');
  assert.ok(strict.pitch.score < 0.7, `strict pitch=${strict.pitch.score}`);
  assert.ok(Math.abs(strict.timing.offsetSec - 0.25) < 0.02 && strict.timing.offsetReliable, `strict offset=${strict.timing.offsetSec}`);
  const tol = run(late, 'tolerant');
  assert.ok(Math.abs(tol.lagSec - 0.25) < 0.03, `lag=${tol.lagSec}`);
  assert.ok(tol.lagReliable, 'الإزاحة موثوقة');
  assert.ok(tol.pitch.score > 0.9, `tolerant pitch=${tol.pitch.score}`);
  assert.ok(Math.abs(tol.timing.offsetSec - 0.25) < 0.02, 'الوضع المتسامح لا يخفي خطأ التوقيت: إزاحة +250ms ظاهرة');
  const perfect = run(userViaDevice(0, {}), 'strict');
  assert.ok(tol.timing.score < perfect.timing.score - 0.2 && tol.timing.score < 0.75, `التأخر 250ms يخفض التوقيت ولا يُخفى: ${tol.timing.score} مقابل ${perfect.timing.score}`);
  // مستخدم مبكّر 150ms ⇒ إشارة سالبة
  const early = run(userViaDevice(0, {}, { early: 0.15 }), 'tolerant');
  assert.ok(Math.abs(early.lagSec + 0.15) < 0.03, `early lag=${early.lagSec}`);
  assert.ok(Math.abs(early.timing.offsetSec + 0.15) < 0.02, `early offset=${early.timing.offsetSec}`);
  assert.match(SIGN_CONVENTION_AR, /tRef = tCtx − δ/);
});

test('3c) إزاحة أكبر من الحد المحدود (±0.3ث) لا تُمتصّ بصمت: تُعلَّم غير موثوقة/عند الحد', () => {
  const r = run(userViaDevice(0.8, {}), 'tolerant');
  assert.ok(r.lagAtBound || !r.lagReliable, `lag=${r.lagSec} atBound=${r.lagAtBound}`);
  assert.ok(r.pitch.score < 0.6);
});

function fakeSeg(session, reason, f0, startCtx, secs = 3, delta = 5) {
  const seg = session.newSegment(reason, { startCtx, settleSec: 0.12, guessDelta: delta });
  seg.tracker.add(startCtx, delta, 0.99);
  for (let k = 0; k < secs * 100; k++) session.addMic({ tCtx: startCtx + k * 0.01, f0, periodicity: 0.95, energyDb: -10, voiced: true });
  return seg;
}

test('9) seek/restart: مقطع جديد يبدأ نظيفًا، لا خلط ولا بيانات قديمة، ولا نقاط أثناء الاستقرار', () => {
  const s = new Session();
  const lat = { inputSec: 0, outputSec: 0, manualSec: 0 };
  const A = fakeSeg(s, 'play', 200, 15.0);      // مرجع 10.0–13.0 بـ 200Hz
  const B = fakeSeg(s, 'seek', 300, 40.0);      // مرجع 35–38 ... ثم نعيد نفس نافذة A
  B.tracker.reset(); B.tracker.add(40.0, 30.0, 0.99);  // بعد seek: δ جديد ⇒ نفس المرجع 10.0–13.0
  const tr = s.userTrack(lat, { tStart: 10.0, tEnd: 13.0 });
  assert.equal(tr.segmentId, B.id, 'المقطع الأحدث وحده');
  const voicedF0 = new Set(Array.from(tr.f0).filter(Number.isFinite));
  assert.deepEqual([...voicedF0], [300], 'لا تظهر عينات المقطع القديم (200Hz) مطلقًا');
  // الإطارات الأولى (استقرار 120ms) غير قابلة للقياس
  const firstMeas = Array.from(tr.measurable).findIndex((v) => v === 1);
  assert.ok(firstMeas >= 12 && firstMeas <= 13, `أول إطار قابل للقياس = ${firstMeas}`);
  for (let i = 0; i < firstMeas; i++) assert.equal(tr.measurable[i], 0);
  // نافذة لا يغطيها المقطع الجديد لا تُملأ من القديم
  const none = s.userTrack(lat, { tStart: 20.0, tEnd: 23.0 });
  assert.equal(none.segmentId, null);
  // مقطع بلا δ مقيس لا يُوضع على المرجع إطلاقًا
  const C = s.newSegment('play', { startCtx: 60, guessDelta: 1 });
  for (let k = 0; k < 300; k++) s.addMic({ tCtx: 60 + k * 0.01, f0: 111, periodicity: 0.9, energyDb: -10, voiced: true });
  const trC = s.userTrack(lat, { tStart: 55, tEnd: 58 });
  assert.equal(trC.segmentId, null);
});

test('12) تشغيل طويل 650ث بانجراف ساعة 100ppm: التتبّع الدوري يبقي الخطأ < 5ms ويقدّر الانجراف', () => {
  const eps = 100e-6, delta0 = 3.3;
  const trueDelta = (tRef) => delta0 + eps * tRef + (tRef * 0); // δ(tRef) = tCtx − tRef = δ0 + ε·tRef (ساعة السياق أسرع)
  const tr = new DeltaTracker();
  const tapAt = (tRefCenter) => {
    const T = [], D = [];
    for (let k = 0; k < 400; k++) {
      const tRef = tRefCenter - 2 + k * 0.01;
      const tCtx = tRef + trueDelta(tRef);
      const i = Math.round((tRef - ref.timeOrigin) / ref.hop);
      T.push(tCtx); D.push(ref.energyDb[i] + 0.3 * Math.sin(k)); // ضجيج قياس صغير
    }
    return { T, D };
  };
  let guess = delta0 + 0.2; // تخمين أولي خاطئ بـ 200ms (من audio.currentTime مثلًا)
  let worst = 0;
  for (const tRefC of [20, 60, 120, 200, 300, 400, 500, 600]) {
    const { T, D } = tapAt(tRefC);
    const r = alignTapToReference(T, D, ref.energyDb, ref.hop, ref.timeOrigin, guess, { searchSec: tr.count ? 0.2 : 0.5 });
    assert.ok(r.ok, `t=${tRefC} corr=${r.corr}`);
    tr.add(T[T.length >> 1], r.delta, r.corr);
    guess = tr.at(T[T.length - 1]);
    const tMid = T[T.length >> 1];
    const err = Math.abs(r.delta - trueDelta(tRefC));
    worst = Math.max(worst, err);
  }
  assert.ok(worst < 0.005, `أسوأ خطأ δ = ${(worst * 1000).toFixed(2)}ms`);
  assert.ok(Math.abs(tr.driftPpm - 100) < 30, `drift=${tr.driftPpm}`);
  // تنبّؤ الانحدار عند زمن بعيد لم يُقَس: خطأ صغير
  const tq = 640 + trueDelta(640);
  assert.ok(Math.abs(tr.at(tq) - trueDelta(640)) < 0.005);
});

test('alignTapToReference: يرفض الإشارة غير المرتبطة بالمرجع (لا يخترع δ)', () => {
  const T = [], D = [];
  let s = 5;
  for (let k = 0; k < 400; k++) { T.push(30 + k * 0.01); D.push(-30 + 20 * (((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296))); }
  const r = alignTapToReference(T, D, ref.energyDb, ref.hop, ref.timeOrigin, 2.0, { searchSec: 1.0 });
  assert.equal(r.ok, false);
  // صمت تام
  const q = alignTapToReference(T, new Array(400).fill(-120), ref.energyDb, ref.hop, ref.timeOrigin, 2.0);
  assert.equal(q.ok, false);
  assert.equal(q.reason, 'no-signal');
});

test('LatencyModel: القيم المقاسة تحل محل المُبلَّغ، واليدوي منفصل (زمن رد الفعل ≠ تأخير الجهاز)', () => {
  const a = new LatencyModel({ baseLatency: 0.01, outputLatency: 0.04, inputLatency: 0.02, manualSec: 0.05 });
  assert.ok(Math.abs(a.totalSec - 0.12) < 1e-12);
  assert.equal(a.source, 'reported-estimate');
  const b = new LatencyModel({ baseLatency: 0.01, outputLatency: 0.04, inputLatency: 0.02, measuredLoopbackSec: 0.2 });
  assert.equal(b.source, 'measured-loopback');
  assert.ok(Math.abs(b.totalSec - 0.2) < 1e-12);
});
