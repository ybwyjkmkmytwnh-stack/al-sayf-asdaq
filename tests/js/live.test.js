import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLive, candidateHint, HintController, HINT_TEXT, LIVE_THRESHOLDS } from '../../web/js/core/live.js';
import { loadRef, userFromRef, CAL } from './helpers.js';

const ref = loadRef();
const T_NOW = 30.0;
const win = { tStart: T_NOW - 4.5, tEnd: T_NOW + 0.2 };
const live = (user, extra = {}) => computeLive(ref, user, { tNow: T_NOW, calibration: CAL, ...extra });

test('مستخدم مطابق: كل المؤشرات خضراء ولا تلميح', () => {
  const l = live(userFromRef(ref, win));
  assert.equal(l.pitch.state, 'ok'); assert.ok(Math.abs(l.pitch.devCents) < 5, `dev=${l.pitch.devCents}`);
  assert.equal(l.level.state, 'ok'); assert.ok(Math.abs(l.level.devDb) < 1);
  assert.equal(l.timing.state, 'ok'); assert.ok(Math.abs(l.timing.lagSec) < 0.03, `lag=${l.timing.lagSec}`);
  assert.equal(candidateHint(l), null);
});

test('طبقة أخفض بـ150 سنت ⇒ «ارفع الطبقة»؛ أعلى ⇒ «اخفض الطبقة»، والتلميحان مختلفان', () => {
  const lo = live(userFromRef(ref, { ...win, centsShift: -150 }));
  const hi = live(userFromRef(ref, { ...win, centsShift: +150 }));
  assert.ok(Math.abs(lo.pitch.devCents + 150) < 8 && lo.pitch.state === 'bad', JSON.stringify(lo.pitch));
  assert.equal(candidateHint(lo), 'pitch-low'); assert.equal(HINT_TEXT['pitch-low'], 'ارفع الطبقة');
  assert.equal(candidateHint(hi), 'pitch-high'); assert.equal(HINT_TEXT['pitch-high'], 'اخفض الطبقة');
  // إزاحة الراحة الثابتة تُزيل الانحراف
  const comfort = live(userFromRef(ref, { ...win, centsShift: 200 }), { offsetCents: 200 });
  assert.equal(comfort.pitch.state, 'ok');
});

test('قوة الصوت: أهدأ بـ8 dB ⇒ «زد قوة الصوت» (لا تلميح طبقة)، وأعلى ⇒ «خفّض قوة الصوت»', () => {
  const q = live(userFromRef(ref, { ...win, dbShift: -8 }));
  assert.equal(q.pitch.state, 'ok');
  assert.ok(Math.abs(q.level.devDb + 8) < 1.0, `dev=${q.level.devDb}`);
  assert.equal(candidateHint(q), 'level-low'); assert.equal(HINT_TEXT['level-low'], 'زد قوة الصوت');
  assert.equal(candidateHint(live(userFromRef(ref, { ...win, dbShift: +9 }))), 'level-high');
});

test('توقيت: متأخر 0.3 ث ⇒ «بدأت متأخرًا»، مبكر ⇒ «بدأت مبكرًا»', () => {
  const late = live(userFromRef(ref, { ...win, delaySec: 0.3 }));
  assert.ok(late.timing.lagSec > 0.2 && late.timing.lagSec < 0.4, `lag=${late.timing.lagSec}`);
  assert.equal(candidateHint(late), 'timing-late'); assert.equal(HINT_TEXT['timing-late'], 'بدأت متأخرًا');
  const early = live(userFromRef(ref, { ...win, delaySec: -0.3 }));
  assert.ok(early.timing.lagSec < -0.2, `lag=${early.timing.lagSec}`);
  assert.equal(candidateHint(early), 'timing-early');
});

test('صمت المستخدم ⇒ غياب (لا تلميح طبقة)، وفشل الجهاز ⇒ غير قابل للقياس (لا غياب)', () => {
  const silent = live(userFromRef(ref, { ...win, mutate: (u) => { u.voiced.fill(0); u.f0.fill(NaN); u.energyDb.fill(-80); } }));
  assert.equal(silent.absent, true); assert.equal(silent.pitch.state, 'none'); assert.equal(candidateHint(silent), null);
  const dead = live(userFromRef(ref, { ...win, measurable: 0 }));
  assert.equal(dead.absent, false); assert.equal(dead.reason, 'unmeasurable');
});

test('مدّ قُطع مبكرًا ⇒ «أطل المد»', () => {
  const s = ref.sustains.find((x) => x.endSec - x.startSec >= 0.75 && x.endSec > 20 && x.endSec < 200);
  const tNow = s.endSec + 0.15;
  const u = userFromRef(ref, { tStart: tNow - 4.5, tEnd: tNow + 0.2, mutate: (uu) => {
    for (let j = 0; j < uu.t.length; j++) if (uu.t[j] > s.startSec + 0.45 * (s.endSec - s.startSec)) { uu.voiced[j] = 0; uu.f0[j] = NaN; uu.energyDb[j] = -80; }
  } });
  const l = computeLive(ref, u, { tNow, calibration: CAL });
  assert.equal(l.sustain.short, true, JSON.stringify(l.sustain));
  assert.equal(candidateHint(l), 'sustain-short'); assert.equal(HINT_TEXT['sustain-short'], 'أطل المد');
  const full = computeLive(ref, userFromRef(ref, { tStart: tNow - 4.5, tEnd: tNow + 0.2 }), { tNow, calibration: CAL });
  assert.equal(full.sustain.short, false);
});

test('HintController: يتطلب تأكيدًا متتاليًا، يبقى حدًا أدنى، ولا يتأرجح مع ضجيج القياس', () => {
  const hc = new HintController({ confirmN: 3, clearN: 3, minShowMs: 1500 });
  const bad = { sustain: {}, timing: {}, pitch: { state: 'bad', devCents: -150 }, level: {} };
  const good = { sustain: {}, timing: {}, pitch: { state: 'ok', devCents: 0 }, level: {} };
  assert.equal(hc.update(bad, 0), null); assert.equal(hc.update(bad, 300), null);
  assert.equal(hc.update(bad, 600).id, 'pitch-low');
  // اختفاء قصير (تقييم واحد) لا يُسقط التلميح
  assert.equal(hc.update(good, 900).id, 'pitch-low'); assert.equal(hc.update(bad, 1200).id, 'pitch-low');
  // ثلاث تقييمات جيدة متتالية لكن قبل الحد الأدنى ⇒ يبقى؛ بعده يزول
  hc.update(good, 1300); hc.update(good, 1400); assert.equal(hc.update(good, 1500).id, 'pitch-low');
  assert.equal(hc.update(good, 2200), null);
  // تلميحان متناوبان لا يظهران (لا استقرار)
  const hc2 = new HintController();
  const a = { ...bad }, b = { sustain: {}, timing: {}, pitch: { state: 'ok' }, level: { state: 'bad', devDb: -9 } };
  const seq = [a, b, a, b, a, b, a, b].map((x, i) => hc2.update(x, i * 300));
  assert.ok(seq.every((x) => x == null), 'بلا استقرار لا يظهر تلميح');
  assert.ok(LIVE_THRESHOLDS.pitchCents.warn > LIVE_THRESHOLDS.pitchCents.ok);
});
