// مقياس مستوى الإدخال الفوري + «اختبر الميكروفون» (٣ ثوانٍ محليًّا مع إعادة استماع) + تصنيف الحالة.
import { h } from './dom.js';

export const INPUT_DB_AUDIBLE = -55;   // دون هذا لا نعدّه صوتًا مسموعًا

/** يصنّف نتيجة تسجيل قصير. يفصل «تصل عيّنات؟» عن «نجح قياس النبرة؟». */
export function classifyInput({ samples, peak, rms, voicedFrac }) {
  const db = 20 * Math.log10((rms || 0) + 1e-9);
  if (!samples || peak < 1e-4) return { kind: 'no-samples', db, text: 'لا يصل أي صوت من الميكروفون المحدد.', fix: 'جرّب ميكروفونًا آخر من القائمة، وارفع مستوى الإدخال في إعدادات النظام، وتأكد أن المتصفح مسموح له بالميكروفون لهذا الملف، وأن تطبيقًا آخر لا يحجبه.' };
  if (db < INPUT_DB_AUDIBLE) return { kind: 'too-quiet', db, text: 'الصوت يصل لكنه خافت جدًّا.', fix: 'قرّب الميكروفون أو ارفع مستوى الإدخال في النظام.' };
  if (voicedFrac < 0.15) return { kind: 'audible-unstable', db, text: 'نسمع صوتك، لكن قياس النبرة غير مستقر.', fix: 'يمكنك التدريب على الكلمات الآن؛ تقييم النغمة قد يكون محدودًا. جرّب مكانًا أهدأ أو قرّب الميكروفون.' };
  return { kind: 'ok', db, text: 'الصوت يصل وقياس النبرة يعمل.', fix: '' };
}

/** شريط مستوى حيّ يتحرّك فور إذن الميكروفون. */
export function levelMeter(eng) {
  const bar = h('i'); const meter = h('div', { class: 'meterbar', role: 'img', 'aria-label': 'مستوى الميكروفون الآن' }, bar);
  const txt = h('span', { class: 'small muted num' }, '—');
  const on = (e) => { const d = e.detail; const p = Math.max(0, Math.min(1, (d.db + 70) / 60)); bar.style.width = `${p * 100}%`; txt.textContent = d.peak < 1e-4 ? 'لا عيّنات صوت' : `${Math.round(d.db)} ديسيبل`; };
  eng.addEventListener('level', on);
  return { el: h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } }, h('div', { style: { flex: '1' } }, meter), txt), dispose: () => eng.removeEventListener('level', on) };
}

/** زر الاختبار: يسجّل ٣ ث محليًّا ثم يعرض التصنيف وزر إعادة الاستماع. */
export function micTestWidget(eng, { onResult = null } = {}) {
  const out = h('div', { class: 'small', role: 'status', 'aria-live': 'polite' });
  const play = h('button', { class: 'btn', id: 'btn-mictest-play', hidden: true }, 'استمع لما سُجّل');
  let clip = null;
  const btn = h('button', { class: 'btn', id: 'btn-mictest' }, 'اختبر الميكروفون (٣ ثوانٍ — قل أي شيء)');
  btn.onclick = async () => {
    btn.disabled = true; play.hidden = true; out.textContent = 'يُسجَّل الآن… تكلّم.';
    let voiced = 0, total = 0;
    const tick = () => { total++; const f = eng.latest; if (f && f.voiced && Number.isFinite(f.f0)) voiced++; };
    eng.addEventListener('level', tick);
    try {
      clip = await eng.recordClip(3);
      const cls = classifyInput({ samples: clip.samples.length, peak: clip.peak, rms: clip.rms, voicedFrac: total ? voiced / total : 0 });
      const rec = { ...cls, peakDb: +(20 * Math.log10(clip.peak + 1e-9)).toFixed(1), rmsDb: +cls.db.toFixed(1), seconds: +clip.sec.toFixed(2), rate: clip.rate, voicedFrac: +(total ? voiced / total : 0).toFixed(2) };
      out.replaceChildren(h('div', { class: `notice ${cls.kind === 'ok' ? '' : cls.kind === 'audible-unstable' ? 'warn' : 'bad'}` }, h('div', null, h('b', null, cls.text), cls.fix ? h('div', { class: 'muted' }, cls.fix) : null,
        h('div', { class: 'tiny muted num', dir: 'ltr' }, `peak ${rec.peakDb} dB · rms ${rec.rmsDb} dB · voiced ${Math.round(rec.voicedFrac * 100)}% · ${rec.seconds}s @ ${rec.rate}Hz`))));
      play.hidden = !clip.samples.length; onResult?.(rec);
    } catch (e) { out.replaceChildren(h('div', { class: 'notice bad' }, h('div', null, e.message || String(e)))); onResult?.({ kind: 'error', text: e.message }); }
    finally { eng.removeEventListener('level', tick); btn.disabled = false; }
  };
  play.onclick = async () => { if (!clip) return; play.disabled = true; try { await eng.playSamples(clip.samples, clip.rate); } finally { play.disabled = false; } };
  return { el: h('div', { class: 'col', style: { gap: '8px' } }, h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, btn, play), out) };
}
