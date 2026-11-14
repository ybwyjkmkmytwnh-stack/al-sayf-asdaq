// السيناريوهات المطلوبة (1–8، 11) على بيانات التحليل الحقيقية للتسجيل المرجعي.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreWindow, SCOPE, computeConfidence, DEFAULT_SCORING } from '../../web/js/core/score.js';
import { suggestComfortOffset } from '../../web/js/core/session.js';
import { loadRef, userFromRef, CAL, W } from './helpers.js';

const ref = loadRef();
const run = (user, extra = {}) => scoreWindow(ref, user, { ...W, mode: 'strict', calibration: CAL, ...extra });

test('1) مرجع مطابق → درجات عالية في كل الأبعاد وتغطية كاملة', () => {
  const r = run(userFromRef(ref, W));
  assert.ok(r.overall > 0.93, `overall=${r.overall}`);
  assert.ok(r.pitch.score > 0.97 && r.pitch.coverage > 0.99, JSON.stringify(r.pitch));
  assert.ok(r.timing.onsetScore > 0.9, `onset=${r.timing.onsetScore} ${r.timing.matchedOnsets}/${r.timing.totalOnsets}`);
  assert.ok(r.timing.sustainScore > 0.95);
  assert.ok(r.pauses.score > 0.9, `pauses=${r.pauses.score} n=${r.pauses.n}`);
  assert.ok(r.dynamics.score > 0.95, `dyn=${r.dynamics.score}`);
  assert.equal(r.scope.assessment, 'performance-similarity');
});

test('2) إزاحة طبقة معروفة: +100 سنت ≈ 0.8، +300 ≈ 0، ووضع الراحة بإزاحة ثابتة يعيدها عالية', () => {
  const p100 = run(userFromRef(ref, { ...W, centsShift: 100 }));
  assert.ok(Math.abs(p100.pitch.score - 0.8) < 0.03, `p100=${p100.pitch.score}`);
  assert.ok(Math.abs(p100.pitch.medianErrCents - 100) < 6, `median err=${p100.pitch.medianErrCents}`);
  const p300 = run(userFromRef(ref, { ...W, centsShift: 300 }));
  assert.ok(p300.pitch.score < 0.05, `p300=${p300.pitch.score}`);
  const comfort = run(userFromRef(ref, { ...W, centsShift: 100 }), { offsetCents: 100 });
  assert.ok(comfort.pitch.score > 0.97, `comfort=${comfort.pitch.score}`);
  const oct = run(userFromRef(ref, { ...W, centsShift: -1200 }), { offsetCents: -1200 });
  assert.ok(oct.pitch.score > 0.97, 'إزاحة أوكتاف ثابتة (صوت مختلف النطاق) تُعوَّض في وضع الراحة');
  assert.ok(run(userFromRef(ref, { ...W, centsShift: -1200 })).pitch.score < 0.05, 'بلا تعويض: أوكتاف بعيد = صفر');
});

test('4) تضخيم سعة صوت خاطئ لا يرفع الدرجة (لا مكافأة لصوت خاطئ عالٍ)', () => {
  // صراخ: نغمة ثابتة 400Hz مجهورة طوال النافذة بقوة عالية
  const shout = (db) => userFromRef(ref, { ...W, mutate: (u) => { u.voiced.fill(1); u.f0.fill(400); u.periodicity.fill(0.95); u.energyDb.fill(db); } });
  const s1 = run(shout(-5)), s2 = run(shout(15));
  assert.ok(s1.pitch.score < 0.05 && s2.pitch.score < 0.05, `pitch ${s1.pitch.score} ${s2.pitch.score}`);
  assert.ok(s1.overall < 0.15 && s2.overall < 0.15, `overall ${s1.overall} ${s2.overall}`);
  assert.ok(s2.overall <= s1.overall + 0.01, 'تضخيم السعة لا يرفع الدرجة');
  assert.ok(s1.timing.sustainScore < 0.1, `ثبات صوت خاطئ لا ينال نقاط مدّ: ${s1.timing.sustainScore}`);
  // لحن خاطئ بإيقاع/وقفات/قوة مطابقة: الطبقة والقوة ≈ 0؛ يبقى الإيقاع والوقفات فقط (موثّق في التقرير)
  const wrong = (db) => userFromRef(ref, { ...W, dbShift: db, mutate: (u) => { for (let i = 0; i < u.f0.length; i++) if (u.voiced[i]) u.f0[i] = 400; } });
  const a = run(wrong(0)), b = run(wrong(20));
  assert.ok(a.pitch.score < 0.05 && b.pitch.score < 0.05 && a.dynamics.score < 0.05 && b.dynamics.score < 0.05);
  assert.ok(a.overall < 0.45 && b.overall <= a.overall + 0.01, `a=${a.overall} b=${b.overall}`);
  // وتضخيم صوت صحيح فوق مستوى المعايرة بـ +20 dB يخفض القوة (ليس مكافأة)
  const loud = run(userFromRef(ref, { ...W, dbShift: 20 }));
  assert.ok(loud.dynamics.score < 0.1 && loud.pitch.score > 0.97);
});

test('5) صمت المستخدم في جزء مطلوب = غياب (صفر)، وليس فشل جهاز', () => {
  const silent = run(userFromRef(ref, { ...W, mutate: (u) => { u.voiced.fill(0); u.f0.fill(NaN); for (let i = 0; i < u.energyDb.length; i++) u.energyDb[i] = -80; } }));
  assert.equal(silent.pitch.score, 0);
  assert.equal(silent.coverage, 0);
  assert.ok(silent.pitch.absentFrames > 500 && silent.pitch.unmeasurableFrames === 0);
  assert.ok(silent.overall < 0.1 && silent.overall != null, `overall=${silent.overall}`);
  // فشل الجهاز (غير قابل للقياس) يُستبعد لا يُحتسب صفرًا
  const dead = run(userFromRef(ref, { ...W, measurable: 0 }));
  assert.equal(dead.overall, null);
  assert.equal(dead.overallReason, 'insufficient-measurable');
  // نصف النافذة غير قابل للقياس: النصف القابل للقياس يُقيَّم وحده
  const half = run(userFromRef(ref, { ...W, mutate: (u) => { for (let i = u.measurable.length >> 1; i < u.measurable.length; i++) u.measurable[i] = 0; } }));
  assert.ok(half.pitch.score > 0.97 && half.measurableFraction < 0.6 && half.pitch.unmeasurableFrames > 300, `half=${half.pitch.score} unmeas=${half.pitch.unmeasurableFrames}`);
});

test('6) صمت المرجع ليس نقاط مجانية: نافذة مرجعها صامت → لا درجة؛ والنشاط في الوقفات يخفض درجة الوقفات فقط', () => {
  // المقدمة الصامتة (0–3.69 ث)
  const intro = scoreWindow(ref, userFromRef(ref, { t0: 0.2, t1: 3.5, mutate: (u) => { u.voiced.fill(0); u.f0.fill(NaN); } }),
    { tStart: 0.2, tEnd: 3.5, mode: 'strict', calibration: CAL });
  assert.equal(intro.overall, null);
  assert.equal(intro.overallReason, 'no-scorable-reference');
  // مستخدم يهمهم أثناء وقفات المرجع
  const base = run(userFromRef(ref, W));
  const hum = run(userFromRef(ref, { ...W, mutate: (u, r, i0) => {
    for (const p of r.pauses) {
      const a = r.idx(p.startSec) - i0 + 2, b = r.idx(p.endSec) - i0 - 2;
      for (let i = Math.max(0, a); i < Math.min(u.t.length, b); i++) { u.voiced[i] = 1; u.f0[i] = 150; u.periodicity[i] = 0.95; u.energyDb[i] = -9; }
    }
  } }));
  assert.ok(base.pauses.n >= 1, `pauses in window=${base.pauses.n}`);
  assert.ok(hum.pauses.score < base.pauses.score - 0.5, `hum=${hum.pauses.score} base=${base.pauses.score}`);
  assert.ok(Math.abs(hum.pitch.score - base.pitch.score) < 0.03, 'الطبقة لا تتأثر (لا نقاط من صمت المرجع)');
});

test('6b) وقفات بلا نشاط حولها لا تنال نقاطًا (حارس النشاط)', () => {
  const quiet = run(userFromRef(ref, { ...W, mutate: (u) => { u.voiced.fill(0); u.f0.fill(NaN); for (let i = 0; i < u.energyDb.length; i++) u.energyDb[i] = -80; } }));
  assert.equal(quiet.pauses.score, 0);
  assert.ok(quiet.pauses.noActivity >= 1);
});

test('7) ضجيج/تصفيق (طاقة عالية بلا جهر) لا ينال نقاطًا', () => {
  let s = 99;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const clap = run(userFromRef(ref, { ...W, mutate: (u) => {
    u.voiced.fill(0); u.f0.fill(NaN);
    for (let i = 0; i < u.energyDb.length; i++) { u.energyDb[i] = -45; if (rnd() < 0.02) for (let k = 0; k < 6 && i + k < u.energyDb.length; k++) u.energyDb[i + k] = -5 - k; }
  } }));
  assert.equal(clap.pitch.score, 0);
  assert.ok(clap.timing.onsetScore === 0 || clap.timing.onsetScore < 0.05, `onset=${clap.timing.onsetScore}`);
  assert.ok(clap.overall < 0.1, `overall=${clap.overall}`);
  // وفوضى عشوائية الطبقة (ضجيج مجهور) لا تعطي درجة عالية
  const rndPitch = run(userFromRef(ref, { ...W, mutate: (u) => { for (let i = 0; i < u.f0.length; i++) if (u.voiced[i]) u.f0[i] = 80 + rnd() * 600; } }));
  assert.ok(rndPitch.pitch.score < 0.2, `random pitch=${rndPitch.pitch.score}`);
});

test('8) الدندنة: النتيجة تحمل نطاق «تشابه الأداء» وتصرّح بعدم تقييم النطق', () => {
  const hum = run(userFromRef(ref, W));          // دندنة بنفس اللحن والتوقيت تنال تشابهًا لحنيًا عاليًا
  assert.equal(hum.scope.pronunciationAssessed, false);
  assert.equal(hum.scope.harakatAssessed, false);
  assert.equal(hum.scope.prosodyAssessed, false);
  assert.match(hum.scope.label, /تقييم تشابه الأداء الصوتي/);
  assert.match(SCOPE.note, /الدندنة/);
  assert.equal(hum.experimental, true);
});

test('11) وضع الراحة: إزاحة ثابتة من المعايرة لا يُعاد تقديرها أثناء الأداء', () => {
  assert.equal(suggestComfortOffset(500, 794.6), -300);
  // منطقة ميتة: فرق صغير لا يُقترح له إزاحة
  assert.equal(suggestComfortOffset(120, 0), 0);
  assert.equal(suggestComfortOffset(-140, 0), 0);
  assert.equal(suggestComfortOffset(-160, 0), -200);
  assert.equal(suggestComfortOffset(1190, 0), 1200);
  assert.equal(suggestComfortOffset(794.6 + 1180, 794.6), 1200);
  // نصف النافذة بإزاحة +100 ونصفها بلا إزاحة، والإزاحة المعايَرة 100 ثابتة: النصف الثاني يخطئ 100 سنت ولا يُصحَّح تلقائيًا
  const U = userFromRef(ref, { ...W, centsShift: 100, mutate: (u) => { for (let i = u.f0.length >> 1; i < u.f0.length; i++) u.f0[i] /= 2 ** (100 / 1200); } });
  const r = run(U, { offsetCents: 100, detail: true });
  const half = r.errTrackCents.length >> 1;
  const med = (a) => { const v = Array.from(a).filter(Number.isFinite).sort((x, y) => x - y); return v[v.length >> 1]; };
  assert.ok(Math.abs(med(r.errTrackCents.subarray(0, half))) < 8);
  assert.ok(Math.abs(med(r.errTrackCents.subarray(half)) + 100) < 8, 'النصف الثاني يُظهر الخطأ −100 كاملًا');
});

test('الثقة: مكبّرات/تسرّب/بلا معايرة تُخفّض الثقة، والتسرّب المؤكد يعطّل التقييم الرقمي', () => {
  const base = { headphones: true, leak: { level: 0.02, detected: false }, latencySource: 'measured-loopback', calibrated: true, measurableFraction: 1, processingOn: false, lagReliable: true };
  assert.equal(computeConfidence(base).value, 1);
  assert.ok(computeConfidence({ ...base, headphones: false, leak: { level: null } }).value <= 0.6);
  const leak = computeConfidence({ ...base, leak: { level: 0.7, detected: true } });
  assert.equal(leak.numericScoringAllowed, false);
  assert.equal(leak.independence, 'violated');
  assert.ok(computeConfidence({ ...base, calibrated: false }).value < 0.75);
});

test('إعدادات التقييم موسومة «تجريبية» وأوزانها مجموعها 1', () => {
  assert.equal(DEFAULT_SCORING.experimental, true);
  assert.ok(Math.abs(Object.values(DEFAULT_SCORING.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});
