import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMediaError, describeVideoServerError, DEVICE_MESSAGES } from '../../web/js/audio/errors.js';

const hasArabic = (t) => /[؀-ۿ]/.test(t);
const noLatinSentence = (t) => !/[A-Za-z]{4,}\s[A-Za-z]{3,}/.test(t); // لا جملة إنجليزية خام

test('كل اسم خطأ معروف يُترجم إلى رمز ثابت ورسالة عربية', () => {
  const table = {
    NotAllowedError: 'permission-denied', PermissionDeniedError: 'permission-denied',
    NotFoundError: 'no-device', DevicesNotFoundError: 'no-device',
    NotReadableError: 'device-busy', TrackStartError: 'device-busy',
    OverconstrainedError: 'constraints', SecurityError: 'insecure-context',
    AbortError: 'aborted', NotSupportedError: 'not-supported',
  };
  for (const [name, code] of Object.entries(table)) {
    const d = describeMediaError({ name, message: 'raw english text' });
    assert.equal(d.code, code, name);
    assert.ok(hasArabic(d.message), name);
    assert.ok(noLatinSentence(d.message), `${name}: ${d.message}`);
  }
});

test('رفض الإذن يذكر أن الاستماع يبقى متاحًا', () => {
  const d = describeMediaError({ name: 'NotAllowedError' });
  assert.equal(d.fatal, true);
  assert.match(d.message, /الاستماع/);
});

test('خطأ مجهول لا يُسقط التطبيق ويحمل اسمه', () => {
  const d = describeMediaError({ name: 'WeirdError', message: 'x' });
  assert.equal(d.code, 'unknown');
  assert.match(d.message, /WeirdError/);
  assert.equal(describeMediaError(null).code, 'unknown');
});

test('غياب خادم الفيديو رسالة غير قاتلة لا تذكر فشل التدريب', () => {
  assert.equal(describeVideoServerError(new Error('x')), DEVICE_MESSAGES.serverAbsent);
  assert.match(DEVICE_MESSAGES.serverAbsent, /التدريب لا يتأثر/);
  assert.match(describeVideoServerError({ name: 'AbortError' }), /مهلة/);
});

test('رسائل الجهاز تقول صراحة أن الفترة لا تُحتسب أو أن التقييم أُوقف', () => {
  assert.match(DEVICE_MESSAGES.trackMuted, /لا تُحتسب/);
  assert.match(DEVICE_MESSAGES.ctxSuspended, /لا تُحتسب/);
  assert.match(DEVICE_MESSAGES.digitalSilence, /لا تُحتسب/);
  assert.match(DEVICE_MESSAGES.trackEnded, /أُوقف التقييم/);
  assert.match(DEVICE_MESSAGES.analysisMismatch, /لن يبدأ التدريب/);
});
