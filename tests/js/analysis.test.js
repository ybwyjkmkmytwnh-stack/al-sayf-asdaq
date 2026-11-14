// 13) رسائل أخطاء الأجهزة بالعربية · 14) رفض ملف تحليل لا يطابق الصوت/النص · سلامة ملف التحليل الحقيقي · تصحيحات التوقيت اليدوية
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertAnalysisMatches, AnalysisMismatchError, validateAnalysisShape, effectiveHemistichs, exportTimings, importTimings, loadOverrides, saveOverrides, overridesKey } from '../../web/js/core/analysis.js';
import { describeMediaError, DEVICE_MESSAGES, describeVideoServerError } from '../../web/js/audio/errors.js';
import { loadAnalysis, ROOT } from './helpers.js';

const a = loadAnalysis();
const mp3 = path.join(ROOT, 'web/audio/reference.mp3');
const mp3Hash = crypto.createHash('sha256').update(fs.readFileSync(mp3)).digest('hex');
const poem = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/poem.json'), 'utf8'));

test('14) ملف التحليل الحقيقي يطابق بصمة الصوت المرفق والنص، ويمرّ التحقق البنيوي', () => {
  assert.deepEqual(validateAnalysisShape(a), []);
  assert.equal(a.audioHash, mp3Hash);
  assert.equal(a.textHash, poem.textHash);
  assert.equal(assertAnalysisMatches(a, { audioHash: mp3Hash, textHash: poem.textHash }), true);
});

test('14b) بصمة صوت مختلفة ⇒ رفض صريح برمز audio-hash ورسالة عربية فيها أمر إعادة التوليد', () => {
  const other = crypto.createHash('sha256').update('تسجيل آخر').digest('hex');
  assert.throws(() => assertAnalysisMatches(a, { audioHash: other, textHash: poem.textHash }),
    (e) => e instanceof AnalysisMismatchError && e.code === 'audio-hash' && /analyze_reference\.py --force/.test(e.message));
  assert.throws(() => assertAnalysisMatches(a, { audioHash: mp3Hash, textHash: '0'.repeat(64) }), (e) => e.code === 'text-hash');
  const broken = { ...a, frames: { ...a.frames, count: a.frames.count + 1 } };
  assert.throws(() => assertAnalysisMatches(broken, { audioHash: mp3Hash }), (e) => e.code === 'schema');
  assert.ok(validateAnalysisShape({}).length > 5);
});

test('لا NaN/Infinity في ملف التحليل (JSON صارم) ولا قيم f0 بلا جهر', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'web/data/reference_analysis.json'), 'utf8');
  assert.ok(!/NaN|Infinity/.test(raw));
  const c = a.frames.columns;
  for (let i = 0; i < a.frames.count; i++) {
    assert.ok((c.voiced[i] === 1) === (c.f0Hz[i] !== null), `i=${i}`);
    if (c.valid[i] === 0) assert.ok(c.invalidReason[i] > 0);
  }
});

test('الأبيات: 71 بيتًا و142 شطرًا متتابعة بلا تداخل، كلها موسومة تقديرية/غير موثوقة (لا «مؤكد»)، والكلمات بلا أزمنة', () => {
  assert.equal(a.verses.length, 71);
  const hs = effectiveHemistichs(a, null);
  assert.equal(hs.length, 142);
  for (let i = 1; i < hs.length; i++) assert.ok(hs[i].startSec >= hs[i - 1].endSec - 1e-9, `h${i}`);
  assert.ok(hs.every((h) => ['estimated', 'unreliable'].includes(h.status)));
  assert.equal(a.words.length, 778);
  assert.ok(a.words.every((w) => w.startSec === null && w.endSec === null && w.timingSource === 'none' && w.status === 'not-measured'));
  assert.ok(a.qualityWarnings.some((w) => w.code === 'ALIGNMENT_NOT_LEXICALLY_VERIFIED'));
  assert.equal(a.scope.pronunciationAssessed, false);
});

test('تصحيح التوقيت اليدوي: يستبدل الأزمنة ويضع status=manual ويُحفظ/يُصدَّر/يُستورد بالبصمات', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const o = loadOverrides(a, storage);
  assert.deepEqual(o.hemistichs, {});
  o.hemistichs.h003 = { startSec: 22.5, endSec: 26.9, status: 'manual' };
  assert.equal(saveOverrides(a, o, storage), true);
  const o2 = loadOverrides(a, storage);
  const hs = effectiveHemistichs(a, o2);
  const h3 = hs.find((h) => h.id === 'h003');
  assert.equal(h3.status, 'manual');
  assert.equal(h3.startSec, 22.5);
  assert.notEqual(h3.autoStartSec, 22.5, 'القيمة التلقائية الأصلية محفوظة للرجوع');
  const txt = exportTimings(a, o2);
  const imported = importTimings(a, txt);
  assert.deepEqual(Object.keys(imported.hemistichs), ['h003']);
  assert.throws(() => importTimings(a, txt.replace(a.audioHash, 'f'.repeat(64))), /مختلف/);
  assert.throws(() => importTimings(a, '{"format":"x"}'), /ليس تصدير/);
  // تصحيح مخزَّن لتسجيل آخر لا يُطبَّق
  store.set(overridesKey(a), JSON.stringify({ ...o2, audioHash: 'e'.repeat(64) }));
  assert.deepEqual(loadOverrides(a, storage).hemistichs, {});
});

test('13) رسائل أخطاء الميكروفون/الجهاز/الخادم واضحة بالعربية ولكل حالة رمز', () => {
  const cases = { NotAllowedError: 'permission-denied', NotFoundError: 'no-device', NotReadableError: 'device-busy', OverconstrainedError: 'constraints', SecurityError: 'insecure-context', AbortError: 'aborted', WeirdError: 'unknown' };
  for (const [name, code] of Object.entries(cases)) {
    const d = describeMediaError({ name, message: 'x' });
    assert.equal(d.code, code);
    assert.match(d.message, /[؀-ۿ]/);
  }
  assert.match(describeMediaError({ name: 'NotAllowedError' }).message, /إذن الميكروفون/);
  for (const k of ['trackEnded', 'trackMuted', 'ctxSuspended', 'digitalSilence', 'serverAbsent', 'analysisMismatch']) assert.match(DEVICE_MESSAGES[k], /[؀-ۿ]/);
  assert.match(DEVICE_MESSAGES.serverAbsent, /التدريب لا يتأثر/);
  assert.match(describeVideoServerError({ name: 'TypeError' }), /غير متاح/);
});
