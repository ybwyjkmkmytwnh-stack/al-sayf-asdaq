// الإقلاع: تنزيل بتقدّم حقيقي + التحقق من بصمات الصوت والنص قبل أن يبدأ أي تدريب.
// عند عدم التطابق يُرفض التحليل بوضوح ولا يُفتح التدريب (التوليد من جديد يتم بأداة بايثون خارج المتصفح).
import { h, icon, loadPrefs, applyPrefs } from './ui/dom.js';
import { App } from './ui/app.js';
import { fetchWithProgress, sha256Hex, poemTextHash, assertAnalysisMatches, AnalysisMismatchError } from './core/analysis.js';

export const APP_VERSION = '1.0.0';
const prefs = loadPrefs();
applyPrefs(prefs);
const root = document.getElementById('app');

const STEPS = [
  ['analysis', 'ملف التحليل المسبق'],
  ['poem', 'نص القصيدة'],
  ['audio', 'التسجيل المرجعي'],
  ['verify', 'التحقق من بصمات الصوت والنص'],
];

function loaderView() {
  const rows = {};
  const list = h('ul', { class: 'steps' }, STEPS.map(([k, lab]) => {
    const dot = h('span', { class: 'dot' }); const st = h('span', { class: 'small muted num' });
    const li = h('li', null, dot, h('div', null, h('div', null, lab), h('div', { class: 'bar', style: { marginTop: '6px' } }, h('i'))), st);
    rows[k] = { li, dot, st, bar: li.querySelector('.bar > i') };
    return li;
  }));
  const err = h('div', { class: 'notice bad', hidden: true, id: 'load-error' });
  const el = h('div', { class: 'loader' }, h('h2', null, 'جارٍ تجهيز التدريب'), h('p', { class: 'muted' }, 'يُحمَّل التسجيل المرجعي وتحليله من الموقع نفسه، ويُتحقَّق من تطابقهما قبل البدء.'), list, err);
  const set = (k, state, pct = null, text = '') => {
    const r = rows[k]; r.li.className = state; r.dot.textContent = state === 'done' ? '✓' : state === 'fail' ? '✕' : '';
    if (pct != null) r.bar.style.width = `${Math.round(pct * 100)}%`; r.st.textContent = text;
  };
  return { el, set, error: (node) => { err.hidden = false; err.replaceChildren(icon('info'), node); } };
}

const mb = (n) => (n / 1048576).toFixed(1);

async function boot() {
  const L = loaderView();
  root.replaceChildren(L.el);
  window.__karaokeBoot = { state: 'loading' };
  let phase = 'analysis';
  try {
    L.set('analysis', 'active', 0);
    const aBuf = await fetchWithProgress('data/reference_analysis.json', (g, t) => L.set('analysis', 'active', t ? g / t : 0.5, `${mb(g)}${t ? ' / ' + mb(t) : ''} م.ب`));
    const analysis = JSON.parse(new TextDecoder().decode(aBuf));
    L.set('analysis', 'done', 1, `${mb(aBuf.byteLength)} م.ب`);
    phase = 'poem';
    L.set('poem', 'active', 0.5);
    const poem = JSON.parse(new TextDecoder().decode(await fetchWithProgress('data/poem.json')));
    let prosody = null;
    try { prosody = JSON.parse(new TextDecoder().decode(await fetchWithProgress('data/prosody.json'))); } catch (e) { console.warn('prosody unavailable', e); }
    L.set('poem', 'done', 1);
    phase = 'audio';
    L.set('audio', 'active', 0);
    const audioBuf = await fetchWithProgress('audio/reference.mp3', (g, t) => L.set('audio', 'active', t ? g / t : 0.5, `${mb(g)}${t ? ' / ' + mb(t) : ''} م.ب`));
    L.set('audio', 'done', 1, `${mb(audioBuf.byteLength)} م.ب`);
    phase = 'verify';
    L.set('verify', 'active', 0.3);
    const [audioHash, textHash] = await Promise.all([sha256Hex(audioBuf), poemTextHash(poem.lines)]);
    L.set('verify', 'active', 0.8);
    if (textHash !== poem.textHash) throw new AnalysisMismatchError('poem-hash', 'ملف نص القصيدة تغيّر عمّا سُجِّل في بصمته.');
    assertAnalysisMatches(analysis, { audioHash, textHash });
    L.set('verify', 'done', 1, 'تطابق ✓');
    const audioUrl = URL.createObjectURL(new Blob([audioBuf], { type: 'audio/mpeg' }));
    const app = new App({ root, data: { analysis, poem, prosody, audioUrl, audioHash, textHash, audioBytes: audioBuf.byteLength }, prefs });
    window.__karaoke = { app, version: APP_VERSION, data: app.data, get engine() { return app.engine; }, ref: app.ref };
    window.__karaokeBoot = { state: 'ready' };
    app.go('home');
  } catch (e) {
    console.error(e);
    L.set(phase, 'fail', null, 'فشل');
    const mismatch = e instanceof AnalysisMismatchError;
    window.__karaokeBoot = { state: 'error', phase, code: e.code || null, message: e.message };
    L.error(h('div', null, h('b', null, mismatch ? 'لن يبدأ التدريب: ' : 'تعذّر التحميل: '), e.message,
      mismatch ? h('div', { class: 'small', style: { marginTop: '8px' } }, 'هذا يعني أن ملف التحليل وُلِّد لتسجيل/نص آخر. التقييم مع تحليل غير مطابق سيكون خاطئًا، فيُرفض. أعد التوليد على الجهاز بالأمر:', h('pre', { class: 'log' }, 'python3 analysis/analyze_reference.py --force')) : null,
      h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: () => boot() }, 'إعادة المحاولة'))));
  }
}
boot();
