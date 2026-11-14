// ملاحظات المراجعة المبنية على القياس (لا نصائح عامة): كل ملاحظة تحمل رقم الشطر والزمن والقيمة المقيسة.
import { fmtTime, fmtNum, arDigits } from './text.js';

export const REASONS_AR = Object.freeze({
  'empty-window': 'نافذة فارغة',
  'no-scorable-reference': 'لا يوجد في هذا الشطر جزء مرجعي مجهور كافٍ للمقارنة',
  'insufficient-measurable': 'لم تصل بيانات ميكروفون قابلة للقياس بما يكفي (انقطاع/كتم/لم يبدأ التقييم)',
  'no-dimension': 'لا بُعد قابل للتقييم',
  'leak-violation': 'الميكروفون يلتقط صوت التسجيل؛ عُطّل التقييم الرقمي',
});

const semitones = (c) => Math.abs(c) / 100;

/** يبني ملاحظات شطر واحد من ناتج Engine.score. h: {index,text,startSec,endSec,status}. */
export function notesForHemistich(h, res, { western = false } = {}) {
  const tag = `الشطر ${arDigits(h.index + 1, western)} (${fmtTime(h.startSec, western)}–${fmtTime(h.endSec, western)})`;
  const notes = [];
  const add = (kind, text, severity = 'info') => notes.push({ kind, text: `${tag}: ${text}`, severity, hemistich: h.index, tStart: h.startSec, tEnd: h.endSec });
  if (!res || res.overall == null) {
    add('unmeasured', REASONS_AR[res?.overallReason] || 'لم يُقَس', 'gray');
    return notes;
  }
  const p = res.pitch, t = res.timing, d = res.dynamics, ps = res.pauses;
  if (p?.coverage != null && p.coverage < 0.5) add('absent', `لم يُسمع صوت مجهور منك في ${fmtNum((1 - p.coverage) * 100, 0, western)}٪ من المواضع التي ينطق فيها المرجع.`, 'bad');
  if (p?.score != null && p.medianErrCents != null && p.coverage >= 0.5) {
    const e = p.medianErrCents;
    if (Math.abs(e) >= 60) add('pitch', `كانت طبقتك ${e < 0 ? 'أخفض' : 'أعلى'} من المرجع بنحو ${fmtNum(Math.abs(e), 0, western)} سنتًا (≈ ${fmtNum(semitones(e), 1, western)} نصف نغمة) في الوسيط.`, Math.abs(e) >= 150 ? 'bad' : 'warn');
    else if (p.p90AbsErrCents != null && p.p90AbsErrCents >= 200) add('pitch-spread', `طبقتك قريبة في المتوسط لكن بعض المواضع انحرفت حتى ${fmtNum(p.p90AbsErrCents, 0, western)} سنتًا.`, 'warn');
  }
  if (t) {
    if (t.offsetReliable && Math.abs(t.offsetSec) >= 0.15) add('timing', `${t.offsetSec > 0 ? 'تأخرت' : 'سبقت'} المرجع بنحو ${fmtNum(Math.abs(t.offsetSec), 2, western)} ث.`, Math.abs(t.offsetSec) >= 0.3 ? 'bad' : 'warn');
    if (!t.offsetReliable && t.score != null) add('timing-unsure', 'تعذّر تحديد إزاحة التوقيت بثقة (غلاف الصوت لا يطابق المرجع بوضوح).', 'warn');
    if (t.sustainScore != null && t.sustainScore < 0.5 && t.sustains > 0) add('sustain', `المدود: ثبتَّ على اللحن في ${fmtNum((t.sustainRatioMedian ?? 0) * 100, 0, western)}٪ من طول المدّ المرجعي (وسيط ${arDigits(t.sustains, western)} مدّ). أطل المدّ.`, 'warn');
  }
  if (d?.score != null && d.medianRelDb != null && Math.abs(d.medianRelDb) >= 6) add('dynamics', `كان صوتك ${d.medianRelDb < 0 ? 'أخفض' : 'أقوى'} نسبيًا من المرجع بنحو ${fmtNum(Math.abs(d.medianRelDb), 0, western)} ديسيبل (مقارنةً بمستوى معايرتك).`, 'warn');
  if (ps?.n > 0 && ps.score != null && ps.score < 0.5) add('pause', `لم تتوقف في ${arDigits(ps.n, western)} وقفة مرجعية كما ينبغي.`, 'warn');
  if (res.lagAtBound) add('lag', 'الإزاحة الزمنية المحلية بلغت حدّ الوضع المتسامح؛ الدرجة قد تكون متفائلة.', 'warn');
  if (!notes.length) add('good', 'لا انحراف ملحوظ في المقاييس المحسوبة.', 'good');
  return notes;
}

/** ملخّص عدة أشطار: متوسط مرجّح بمدة الشطر القابلة للقياس + أبعاد منفصلة. results: [{h,res}] */
export function summarize(results) {
  const dims = ['pitch', 'timing', 'pauses', 'dynamics'];
  const acc = { overall: [0, 0], pitch: [0, 0], timing: [0, 0], pauses: [0, 0], dynamics: [0, 0] };
  let measured = 0, unmeasured = 0, conf = [];
  for (const { h, res } of results) {
    const w = Math.max(0.1, h.endSec - h.startSec);
    if (!res || res.overall == null) { unmeasured++; continue; }
    measured++;
    acc.overall[0] += res.overall * w; acc.overall[1] += w;
    for (const k of dims) if (res[k]?.score != null) { acc[k][0] += res[k].score * w; acc[k][1] += w; }
    if (res.confidence) conf.push(res.confidence.value);
  }
  const f = (k) => (acc[k][1] > 0 ? acc[k][0] / acc[k][1] : null);
  return { overall: f('overall'), pitch: f('pitch'), timing: f('timing'), pauses: f('pauses'), dynamics: f('dynamics'),
    measured, unmeasured, confidence: conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null };
}

export const stateForScore = (s) => (s == null ? 'none' : s >= 0.8 ? 'ok' : s >= 0.55 ? 'warn' : 'bad');
export const STATE_SYMBOL = Object.freeze({ ok: '✓', warn: '▲', bad: '✕', none: '–' });
export const STATE_WORD = Object.freeze({ ok: 'جيد', warn: 'متوسط', bad: 'ضعيف', none: 'غير مقيس' });
