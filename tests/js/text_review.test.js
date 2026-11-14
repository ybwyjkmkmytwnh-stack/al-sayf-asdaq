import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAr, arDigits, fmtTime } from '../../web/js/core/text.js';
import { notesForHemistich, summarize, stateForScore } from '../../web/js/core/review.js';
import { scoreWindow } from '../../web/js/core/score.js';
import { loadAnalysis, loadRef, userFromRef, CAL } from './helpers.js';

const a = loadAnalysis(), ref = loadRef();
const hems = a.verses.flatMap((v) => v.hemistichs);

test('normalizeAr في JS يطابق normalizedText من بايثون لكل الأشطار الـ142', () => {
  for (const h of hems) assert.equal(normalizeAr(h.text), h.normalizedText, h.id);
});

test('تنسيق الأرقام والأزمنة', () => {
  assert.equal(arDigits('12:34'), '١٢:٣٤');
  assert.equal(fmtTime(65.25), '٠١:٠٥.٣'.replace('٥.٣', '٥.٣'));
  assert.equal(fmtTime(65.25, true), '01:05.3');
  assert.equal(fmtTime(NaN), '—');
});

const H = { index: 12, text: 'x', startSec: 22.4, endSec: 26.9, status: 'estimated' };
const W = { tStart: H.startSec, tEnd: H.endSec };
const score = (u, extra = {}) => scoreWindow(ref, u, { ...W, mode: 'strict', calibration: CAL, ...extra });

test('ملاحظات المراجعة: مطابق ⇒ «لا انحراف»؛ إزاحة طبقة وتأخر وقوة ⇒ ملاحظات قياسية بالقيم', () => {
  const good = notesForHemistich(H, score(userFromRef(ref, W)));
  assert.deepEqual(good.map((n) => n.kind), ['good']);
  const bad = notesForHemistich(H, score(userFromRef(ref, { ...W, centsShift: -150, delaySec: 0.3, dbShift: -9 })));
  const kinds = bad.map((n) => n.kind);
  assert.ok(kinds.includes('pitch') && kinds.includes('timing') && kinds.includes('dynamics'), kinds.join());
  const pn = bad.find((n) => n.kind === 'pitch').text;
  assert.match(pn, /أخفض/); assert.match(pn, /الشطر ١٣/);
  assert.match(bad.find((n) => n.kind === 'timing').text, /تأخرت/);
  assert.match(bad.find((n) => n.kind === 'dynamics').text, /أخفض/);
});

test('غياب ⇒ ملاحظة غياب؛ فشل جهاز ⇒ «لم يُقَس» لا «صفر»', () => {
  const silent = notesForHemistich(H, score(userFromRef(ref, { ...W, mutate: (u) => { u.voiced.fill(0); u.f0.fill(NaN); u.energyDb.fill(-80); } })));
  assert.ok(silent.some((n) => n.kind === 'absent'), JSON.stringify(silent.map((n) => n.kind)));
  const dead = notesForHemistich(H, score(userFromRef(ref, { ...W, measurable: 0 })));
  assert.equal(dead[0].kind, 'unmeasured'); assert.equal(dead[0].severity, 'gray');
});

test('summarize: يستبعد غير المقيس من المتوسط ويعدّه', () => {
  const r1 = { h: H, res: { overall: 0.9, pitch: { score: 0.9 }, timing: { score: 0.8 }, pauses: { score: null }, dynamics: { score: 0.7 }, confidence: { value: 0.8 } } };
  const r2 = { h: H, res: { overall: null } };
  const s = summarize([r1, r2]);
  assert.equal(s.measured, 1); assert.equal(s.unmeasured, 1);
  assert.ok(Math.abs(s.overall - 0.9) < 1e-9 && s.pauses == null);
  assert.equal(stateForScore(0.85), 'ok'); assert.equal(stateForScore(0.6), 'warn'); assert.equal(stateForScore(0.2), 'bad'); assert.equal(stateForScore(null), 'none');
});
