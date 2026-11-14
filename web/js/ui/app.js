// متحكّم الواجهة: الشاشات (رئيسية، معايرة، تدريب، مراجعة، فهرس، محرّر توقيت، إعدادات، شرح).
// لا يبدأ أي تشغيل صوتي إلا من معالج نقر صريح. الميكروفون لا يُوصل بالمكبّر في أي مسار.
import { h, icon, toast, savePrefs, applyPrefs, prefersReducedMotion } from './dom.js';
import { Engine, supportInfo } from '../audio/engine.js';
import { ReferenceData, effectiveHemistichs, loadOverrides, saveOverrides, exportTimings, importTimings } from '../core/analysis.js';
import { normalizeAr, arDigits, fmtTime, fmtNum, fmtPct } from '../core/text.js';
import { SCOPE } from '../core/score.js';
import { notesForHemistich, summarize, stateForScore, STATE_SYMBOL, STATE_WORD } from '../core/review.js';
import { LIVE_THRESHOLDS } from '../core/live.js';
import { PitchView } from './pitchview.js';
import { TimingEditor } from './editor.js';
import { videoCard } from './video.js';
import { Cloud, uuid, summarizeAttempts } from '../cloud/client.js';
import { levelMeter, micTestWidget, classifyInput } from './mictest.js';
import { SpeechListener, sttSupport, STT_ERRORS } from '../audio/stt.js';
import { compareWords, countsAsRead, describeDiff } from '../core/speech.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATUS_LABEL = { estimated: 'حدود تقديرية', unreliable: 'ضعيفة الثقة', manual: 'مصحَّحة يدويًا', confirmed: 'مؤكَّدة' };
const STATUS_CLASS = { estimated: 'warn', unreliable: 'bad', manual: 'ok', confirmed: 'ok' };

/** مشغّل بسيط لعنصر <audio> (للاستماع والمحرّر والنقر على التوقيت) — لا يحتاج AudioWorklet ولا ميكروفون. */
class PlainPlayer {
  constructor(url) { this.a = new Audio(url); this.a.preload = 'auto'; this.range = null; this.timer = null; this.onTick = null; }
  get t() { return this.a.currentTime; }
  async playRange(start, end = null) {
    this.stop();
    this.range = { start, end };
    this.a.currentTime = Math.max(0, start);
    await this.a.play();
    this.timer = setInterval(() => {
      this.onTick?.(this.a.currentTime);
      if (this.range?.end != null && this.a.currentTime >= this.range.end) this.stop();
    }, 40);
  }
  stop() { clearInterval(this.timer); this.timer = null; try { this.a.pause(); } catch { /* */ } this.onEnd?.(); }
  dispose() { this.stop(); this.a.src = ''; }
}

export class App {
  constructor({ root, data, prefs }) {
    this.root = root; this.data = data; this.prefs = prefs;
    this.ref = new ReferenceData(data.analysis);
    this.cloud = new Cloud({ url: data.cloud?.url, anonKey: data.cloud?.anonKey, appVersion: 'v2-dev' });
    this.cloud.addEventListener('expired', () => { try { toast('انتهت جلسة الدخول — سجّل الدخول لمتابعة الحفظ.'); } catch { /* */ } });
    this.overrides = loadOverrides(data.analysis);
    this.refreshHems();
    this.engine = null;
    this.results = new Map();
    this.cur = null;
    this.idx = Math.min(this.hems.length - 1, Math.max(0, prefs.lastIndex | 0));
    this.practiceMode = 'line';
  }

  // ───────────────────────── مساعدات ─────────────────────────
  get western() { return this.prefs.digits === 'western'; }
  d(x) { return arDigits(x, this.western); }
  ft(s) { return fmtTime(s, this.western); }
  refreshHems() { this.hems = effectiveHemistichs(this.data.analysis, this.overrides); }
  hemIndexAt(t) {
    const a = this.hems; let lo = 0, hi = a.length - 1, r = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].startSec <= t) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  }
  save() { savePrefs(this.prefs); applyPrefs(this.prefs); }
  setIdx(i) { this.idx = Math.max(0, Math.min(this.hems.length - 1, i)); this.prefs.lastIndex = this.idx; savePrefs(this.prefs); }

  async ensureEngine() {
    if (!this.engine) {
      this.engine = new Engine({ ref: this.ref, audioUrl: this.data.audioUrl });
      this.engine.settings.mode = this.prefs.mode; this.engine.settings.headphones = this.prefs.headphones;
      this.engine.settings.listenVolume = this.prefs.listenVolume; this.engine.settings.manualSec = this.prefs.manualMs / 1000;
      this.engine.addEventListener('device', (e) => this.onDeviceEvent(e.detail));
    }
    await this.engine.init();
    return this.engine;
  }

  onDeviceEvent(ev) {
    const important = ['mic-ended', 'mic-muted', 'ctx-suspended', 'digital-silence', 'leak-detected', 'tab-hidden', 'media-stall', 'discontinuity', 'device-switched'];
    if (important.includes(ev.code) && ev.message) toast(ev.message, 6000);
    this.cur?.onDevice?.(ev);
  }

  go(name, params = {}) {
    try { this.cur?.dispose?.(); } catch (e) { console.error(e); }
    const scr = this[`screen_${name}`](params);
    this.cur = scr; this.screenName = name;
    this.root.replaceChildren(scr.el);
    window.scrollTo(0, 0);
    this.root.dispatchEvent(new CustomEvent('screen', { detail: name }));
    return scr;
  }

  top(title, { back = 'home', extra = null } = {}) {
    return h('div', { class: 'top' },
      back ? h('button', { class: 'btn icon ghost', 'aria-label': 'رجوع', onclick: () => this.go(back) }, icon('back')) : null,
      h('h3', { class: 'grow' }, title), extra);
  }

  badge(hem) {
    const label = STATUS_LABEL[hem.status] || hem.status;
    return h('span', { class: `chip ${STATUS_CLASS[hem.status] || ''}`, title: 'حدود الشطر مقدّرة من بنية الصوت لا من تعرّف على الكلمات؛ يمكنك تصحيحها.' }, label);
  }

  /** التقطيع العروضي (بحر البسيط) تحت الشطر: / متحرك ، ○ ساكن ، مع التفعيلات. آلي وغير مراجَع. */
  scanNodes(idx, { caption = true } = {}) {
    const P = this.data.prosody; const v = P && P.verses && P.verses[idx >> 1];
    if (!v) return [];
    const part = idx & 1, n1 = v.n1;
    const ws = part ? v.words.slice(n1) : v.words.slice(0, n1);
    const feet = v.feet ? (part ? v.feet.slice(4) : v.feet.slice(0, 4)) : [];
    const sym = (p) => [...p].map((c) => (c === '1' ? '/' : '○')).join('');
    const row = h('div', { class: 'scan-words', lang: 'ar' }, ws.map((w) => h('span', { class: 'scan-w' }, h('span', { class: 'scan-t' }, w.text), h('span', { class: 'scan-p', dir: 'ltr' }, sym(w.pattern)))));
    const nodes = [row];
    if (feet.length) nodes.push(h('div', { class: 'scan-feet small', lang: 'ar' }, feet.map((f, i) => h('span', { class: 'scan-foot', title: sym(f.pattern) }, f.name))));
    else nodes.push(h('div', { class: 'scan-feet small muted' }, 'لم يطابق التقطيع الآلي تفعيلات البسيط لهذا البيت؛ يحتاج مراجعة.'));
    if (caption) nodes.push(h('div', { class: 'scan-cap small muted' }, `بحر ${P.meter} · / متحرك ○ ساكن · تقطيع آلي غير مراجَع بشريًا`));
    else row.title = `بحر ${P.meter} · / متحرك ○ ساكن · تقطيع آلي غير مراجَع بشريًا`;
    return nodes;
  }

  // ───────────────────────── الرئيسية ─────────────────────────
  screen_home() {
    const poem = this.data.poem;
    const sup = supportInfo();
    const warn = h('div', { class: 'notice warn', hidden: true });
    const start = () => {
      if (sup.micPolicyBlocked || !sup.secureContext || !sup.audioWorklet || !sup.getUserMedia) {
        warn.hidden = false;
        warn.replaceChildren(icon('info'), h('div', null,
          sup.micPolicyBlocked ? 'هذه الصفحة مفتوحة داخل إطار معاينة يمنع الميكروفون مهما كانت إعداداتك، فلا يفيد «السماح». لتجربة الميكروفون شغّل الموقع على جهازك: python3 serve.py ثم افتح http://localhost:8000 في Chrome. يمكنك الآن الاستماع فقط.' : !sup.secureContext ? 'الميكروفون يتطلب صفحة آمنة. افتح الموقع عبر http://localhost:8000 (شغّل python3 serve.py على هذا الجهاز) أو عبر HTTPS. يمكنك الآن الاستماع فقط.' : 'هذا المتصفح لا يدعم AudioWorklet أو الميكروفون. جرّب نسخة حديثة من Chrome أو Safari. يمكنك الاستماع فقط.'));
        return;
      }
      const e = this.engine;
      if (e?.micOn && e.calibration.done) this.go('practice'); else this.go('setup');
    };
    const el = h('div', { class: 'hero' },
      h('div', { class: 'poet' }, poem.poet),
      h('div', { class: 'poem-title', lang: 'ar' }, poem.title),
      h('p', { class: 'lead' }, 'اقرأ القصيدة مع التسجيل المرجعي، وشاهد تشابه لحنك وتوقيتك وقوة صوتك مع التسجيل لحظةً بلحظة.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary big', id: 'start-training', onclick: start }, 'ابدأ التدريب'),
        h('div', { class: 'sub-actions' },
          h('button', { class: 'btn', onclick: () => this.go('listen') }, icon('ear'), 'استماع فقط'),
          h('button', { class: 'btn', onclick: () => this.go('browse') }, icon('list'), 'فهرس الأبيات'),
          h('button', { class: 'btn', id: 'btn-account', onclick: () => this.go('account') }, icon('info'), 'حسابي وتدريباتي'),
          h('button', { class: 'btn', onclick: () => this.go('settings') }, icon('gear'), 'الإعدادات'),
          h('button', { class: 'btn', onclick: () => this.go('about') }, icon('info'), 'كيف يعمل؟'))),
      h('div', { class: 'notice' }, icon('headphones'), h('div', null, h('b', null, 'يُنصح باستعمال سماعات. '), 'بدونها قد يلتقط الميكروفون صوت التسجيل فتنخفض الثقة أو يتعطّل التقييم الرقمي.')),
      warn,
      h('div', { class: 'facts' },
        h('span', { class: 'chip accent' }, `${this.d(poem.verseCount)} بيتًا`), h('span', { class: 'chip accent' }, `${this.d(poem.hemistichCount)} شطرًا`),
        h('span', { class: 'chip' }, SCOPE.label), h('span', { class: 'chip' }, 'لا يقيّم النطق ولا الحركات')));
    return { el };
  }

  // ───────────────────────── استماع فقط ─────────────────────────
  screen_listen() {
    const pl = new PlainPlayer(this.data.audioUrl);
    pl.a.volume = this.prefs.listenVolume;
    const cur = h('div', { class: 'poem-cur', lang: 'ar' }), nxt = h('div', { class: 'poem-next', lang: 'ar' });
    const scanBox = h('div', { class: 'scanbox' });
    const time = h('span', { class: 'num muted' }, this.ft(0));
    const seek = h('input', { type: 'range', min: 0, max: this.data.analysis.durationSec, step: 0.1, value: 0, 'aria-label': 'موضع التسجيل', style: { width: '100%' } });
    const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: this.prefs.listenVolume, 'aria-label': 'مستوى الاستماع', oninput: () => { pl.a.volume = +vol.value; this.prefs.listenVolume = +vol.value; savePrefs(this.prefs); } });
    const btn = h('button', { class: 'btn primary round', 'aria-label': 'تشغيل' }, icon('play'));
    const show = (t) => { const i = this.hemIndexAt(t); const hm = this.hems[i]; cur.textContent = t < this.hems[0].startSec ? '' : hm.text; nxt.textContent = this.hems[i + 1]?.text || ''; scanBox.replaceChildren(...(t < this.hems[0].startSec ? [] : this.scanNodes(i))); time.textContent = this.ft(t); if (!seek.matches(':active')) seek.value = t; };
    pl.onTick = show;
    pl.a.addEventListener('play', () => { btn.replaceChildren(icon('pause')); btn.setAttribute('aria-label', 'إيقاف مؤقت'); });
    pl.a.addEventListener('pause', () => { btn.replaceChildren(icon('play')); btn.setAttribute('aria-label', 'تشغيل'); });
    btn.onclick = async () => { if (pl.a.paused) { try { await pl.a.play(); pl.timer ||= setInterval(() => pl.onTick?.(pl.a.currentTime), 100); } catch (e) { toast('تعذّر التشغيل: ' + e.message); } } else pl.a.pause(); };
    seek.oninput = () => { pl.a.currentTime = +seek.value; show(+seek.value); };
    const el = h('div', { class: 'wrap col' }, this.top('استماع فقط'),
      h('div', { class: 'card lines' }, cur, scanBox, nxt),
      h('div', { class: 'card col' }, seek, h('div', { class: 'row' }, time, h('span', { class: 'grow' }), h('label', { class: 'volume' }, 'مستوى الاستماع', vol)),
        h('div', { class: 'controls' }, btn)),
      h('p', { class: 'small muted center' }, 'وضع الاستماع لا يستعمل الميكروفون ولا يقيّم شيئًا.'));
    return { el, dispose: () => pl.dispose() };
  }

  // ───────────────────────── المعايرة/الإعداد ─────────────────────────
  screen_setup() {
    const sup = supportInfo();
    const st = { noise: null, voice: null, leak: null, raf: null };
    const cards = {};
    const err = (c, msg) => { c.err.hidden = !msg; c.err.textContent = msg || ''; };
    const meter = h('div', { class: 'meterbar', role: 'img', 'aria-label': 'مستوى الميكروفون' }, h('i'));
    const pitchRead = h('span', { class: 'small muted num' }, '—');
    const mk = (no, title, body) => { const c = { el: h('div', { class: 'card stepcard' }), err: h('div', { class: 'notice bad', hidden: true }), res: h('div', { class: 'small' }), no: h('div', { class: 'no' }, this.d(no)) }; c.el.append(c.no, h('div', { class: 'col', style: { gap: '8px' } }, h('h3', null, title), body, c.res, c.err)); return c; };
    const setDone = (c, ok = true) => { c.el.classList.toggle('done', ok); c.no.textContent = ok ? '✓' : c.no.textContent; };
    const run = async (btn, c, fn) => { err(c, null); btn.disabled = true; try { await fn(); } catch (e) { err(c, e.message || String(e)); } finally { btn.disabled = false; } };

    // ١) الاستماع
    const choice = h('div', { class: 'choice' });
    const setMode = (hp) => { this.prefs.headphones = hp; savePrefs(this.prefs); [bHp, bSp].forEach((b) => b.setAttribute('aria-pressed', String((b === bHp) === hp))); if (this.engine) this.engine.settings.headphones = hp; };
    const bHp = h('button', { type: 'button', onclick: () => setMode(true) }, h('b', null, 'سماعات (موصى به)'), h('span', { class: 'small muted' }, 'أدقّ تقييم: الميكروفون لا يسمع التسجيل.'));
    const bSp = h('button', { type: 'button', onclick: () => setMode(false) }, h('b', null, 'مكبّرات'), h('span', { class: 'small muted' }, 'ثقة أقل: قد يلتقط الميكروفون التسجيل؛ يُفعَّل إلغاء الصدى.'));
    choice.append(bHp, bSp); setMode(this.prefs.headphones);
    const c1 = mk(1, 'كيف تستمع؟', choice);
    // ٢) الميكروفون
    const devSel = h('select', { 'aria-label': 'اختيار الميكروفون', hidden: true, onchange: async () => { try { await this.engine.switchMic(devSel.value); showTrack(); resetCal(); } catch (e) { err(c2, e.message); } } });
    const b2 = h('button', { class: 'btn primary', id: 'btn-mic' }, icon('mic'), 'السماح بالميكروفون');
    const micExtras = h('div', { class: 'col', style: { gap: '8px' } });
    const c2 = mk(2, 'الميكروفون', h('div', { class: 'col', style: { gap: '8px' } }, b2, devSel, micExtras));
    const mountMicExtras = () => {
      if (micExtras.childElementCount || !this.engine) return;
      const lm = levelMeter(this.engine), mt = micTestWidget(this.engine);
      st.lm = lm;
      micExtras.append(h('div', { class: 'small muted' }, 'يتحرّك الشريط فور وصول الصوت — جرّب الكلام الآن:'), lm.el, mt.el,
        h('div', { class: 'tiny muted' }, 'التدريب على الكلمات لا ينتظر معايرة النبرة؛ المعايرة أدناه اختيارية وتحسّن تقييم النغمة فقط.'));
    };
    const showTrack = async () => {
      const e = this.engine, t = e.trackInfo, ctx = e.status().ctx;
      const proc = t.processing;
      const lbl = (v) => (v === true ? 'فعّال' : v === false ? 'معطّل' : 'غير معروف');
      c2.res.replaceChildren(h('div', null, `الجهاز: ${t.label || 'ميكروفون'} · معدل المعالجة ${this.d(ctx.sampleRate)} هرتز`),
        h('div', { class: t.processingOn ? 'notice warn' : 'muted' }, `معالجة المتصفح — تحكم تلقائي بالمستوى: ${lbl(proc.agc)} · خفض الضجيج: ${lbl(proc.ns)} · إلغاء الصدى: ${lbl(proc.ec)}${t.processingOn ? '. قد تؤثر على دقة القياس وتخفّض الثقة.' : '.'}`),
        h('div', { class: 'muted' }, t.inputLatencyKnown ? `كمون الإدخال المُبلَّغ: ${this.d(Math.round(t.settings.latency * 1000))} م.ث` : 'كمون الإدخال غير مُبلَّغ من المتصفح (يُقدَّر 0 مع خفض الثقة؛ يمكنك الضبط اليدوي).'));
      try { const devs = await e.listDevices(); if (devs.length > 1) { devSel.hidden = false; devSel.replaceChildren(...devs.map((d) => h('option', { value: d.deviceId, selected: d.deviceId === t.deviceId }, d.label))); } } catch { /* */ }
      setDone(c2); b3.disabled = b4.disabled = b5.disabled = false; mountMicExtras();
    };
    b2.onclick = () => run(b2, c2, async () => { await this.ensureEngine(); await this.engine.enableMic({ headphones: this.prefs.headphones }); await showTrack(); loop(); });
    // ٣) الضجيج
    const b3 = h('button', { class: 'btn', id: 'btn-noise', disabled: true }, 'قياس ضجيج الغرفة (٣ ثوانٍ — ابقَ صامتًا)');
    const prog3 = h('div', { class: 'bar' }, h('i'));
    const c3 = mk(3, 'ضجيج الغرفة', h('div', { class: 'col', style: { gap: '8px' } }, meter, pitchRead, b3, prog3));
    b3.onclick = () => run(b3, c3, async () => {
      const r = await this.engine.measureNoise(2.8, (p) => { prog3.firstChild.style.width = `${p * 100}%`; });
      st.noise = r; setDone(c3);
      c3.res.textContent = `أرضية الضجيج ${this.d(r.noiseFloorDb.toFixed(0))} ديسيبل${r.contaminated ? ' — يبدو أنك تكلّمت أثناء القياس؛ اعتمدنا أهدأ جزء. لأفضل نتيجة أعد القياس وأنت صامت.' : r.noisy ? ' — الغرفة صاخبة؛ اقترب من الميكروفون أو غيّر المكان.' : ' — ممتازة.'}`;
    });
    // ٤) صوتك
    const b4 = h('button', { class: 'btn', id: 'btn-voice', disabled: true }, 'قياس صوتك (٦ ثوانٍ — اقرأ بيتًا بصوت مريح)');
    const prog4 = h('div', { class: 'bar' }, h('i'));
    const semi = h('input', { type: 'number', min: -12, max: 12, step: 1, value: 0, 'aria-label': 'إزاحة الراحة بأنصاف النغمات', style: { maxWidth: '8rem' }, onchange: () => { this.engine.setComfortOffset(+semi.value * 100); } });
    const off0 = h('button', { class: 'link', type: 'button', onclick: () => { semi.value = 0; this.engine.setComfortOffset(0); } }, 'استعمل نغمة التسجيل نفسها (بلا إزاحة)');
    const offBox = h('div', { class: 'field', hidden: true }, h('div', { class: 'l' }, 'إزاحة الراحة (أنصاف نغمات، ثابتة طوال الجلسة)'), h('div', { class: 'row' }, semi, off0),
      h('div', { class: 'tiny muted' }, 'إن كان صوتك أعلى/أخفض بطبيعته من المسجِّل فاستعمل إزاحة ثابتة؛ تُقاس طبقتك بعد تعويضها (وضع الراحة).'));
    const c4 = mk(4, 'صوتك', h('div', { class: 'col', style: { gap: '8px' } }, b4, prog4, offBox));
    b4.onclick = () => run(b4, c4, async () => {
      const r = await this.engine.measureVoice(6, (p) => { prog4.firstChild.style.width = `${p * 100}%`; });
      st.voice = r; setDone(c4);
      semi.value = Math.round(r.offsetCents / 100); offBox.hidden = false;
      c4.res.textContent = `مستوى صوتك المريح ${this.d(r.comfortLevelDb.toFixed(0))} ديسيبل · وسيط طبقتك أعلى من نغمة التسجيل بـ ${this.d(((r.userMedianCents - (this.ref.a.stats.medianCentsRe100Hz)) / 100).toFixed(1))} نصف نغمة · إزاحة مقترحة ${this.d(Math.round(r.offsetCents / 100))}.`;
    });
    // ٥) التسرّب
    const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: this.prefs.listenVolume, 'aria-label': 'مستوى الاستماع', oninput: () => { this.prefs.listenVolume = +vol.value; savePrefs(this.prefs); this.engine?.setListenVolume(+vol.value); } });
    const b5 = h('button', { class: 'btn', id: 'btn-leak', disabled: true }, 'فحص التسرّب (٦ ثوانٍ — يُشغَّل التسجيل وأنت صامت)');
    const prog5 = h('div', { class: 'bar' }, h('i'));
    const c5 = mk(5, 'هل يسمع الميكروفون التسجيل؟', h('div', { class: 'col', style: { gap: '8px' } }, h('label', { class: 'volume' }, 'مستوى الاستماع', vol), b5, prog5));
    b5.onclick = () => run(b5, c5, async () => {
      this.engine.setListenVolume(+vol.value);
      st.leak = await this.engine.probeLeak({ sec: 6, onProgress: (p) => { prog5.firstChild.style.width = `${p * 100}%`; } });
      const l = st.leak;
      if (!l.valid) { c5.res.textContent = l.userSilent === false ? 'لم تكن صامتًا أثناء الفحص (سُمع صوت). أعد الفحص وابقَ صامتًا.' : 'تعذّر قياس التسرّب (لم يصل التقاط كافٍ).'; return; }
      setDone(c5);
      c5.res.replaceChildren(h('span', { class: `chip ${l.detected ? 'bad' : l.weak ? 'warn' : 'ok'}` }, l.detected ? '✕ تسرّب: الميكروفون يلتقط التسجيل' : l.weak ? '▲ تسرّب ضعيف' : '✓ لا تسرّب'),
        ` الارتباط ${this.d(l.level.toFixed(2))}${l.lagMs != null ? ` عند ${this.d(Math.round(l.lagMs))} م.ث` : ''}.`,
        l.detected ? ' اخفض مستوى الاستماع أو استعمل سماعات ثم أعد الفحص؛ التقييم الرقمي معطّل حتى يزول التسرّب.' : '');
    });
    const resetCal = () => { st.noise = st.voice = st.leak = null; for (const c of [c3, c4, c5]) { c.el.classList.remove('done'); c.res.textContent = ''; } };

    const finish = h('button', { class: 'btn primary big', id: 'btn-finish-setup', onclick: () => {
      try { if (st.voice && st.noise) this.engine.completeCalibration(); } catch (e) { toast(e.message); return; }
      this.go('practice');
    } }, 'ابدأ التدريب');
    const skipNote = h('p', { class: 'small muted center' }, 'بدون معايرة الضجيج وصوتك يعمل التدريب لكن بلا بُعد القوة وبثقة أقل. فحص التسرّب اختياري لكنه يرفع الثقة.');
    const secure = sup.micPolicyBlocked || !sup.secureContext || !sup.audioWorklet;
    const el = h('div', { class: 'wrap col' }, this.top('إعداد الميكروفون والمعايرة'),
      secure ? h('div', { class: 'notice bad' }, icon('info'), h('div', null, sup.micPolicyBlocked ? 'هذه الصفحة مفتوحة داخل إطار معاينة يمنع الميكروفون مهما كانت إعداداتك، فلا يفيد «السماح». لتجربة الميكروفون شغّل الموقع على جهازك: python3 serve.py ثم افتح http://localhost:8000 في Chrome. يمكنك الآن الاستماع فقط.' : 'الميكروفون/المعالجة الحية غير متاحة في هذه الصفحة (يلزم localhost أو HTTPS ومتصفح حديث). يمكنك الاستماع فقط.')) : null,
      c1.el, c2.el, c3.el, c4.el, c5.el, h('div', { class: 'center col' }, finish, skipNote));
    const loop = () => {
      const e = this.engine; const f = e?.latest;
      if (f) { const p = Math.max(0, Math.min(1, (f.energyDb + 80) / 80)); meter.firstChild.style.width = `${p * 100}%`; pitchRead.textContent = f.voiced && Number.isFinite(f.f0) ? `${this.d(Math.round(f.f0))} هرتز` : '—'; }
      st.raf = requestAnimationFrame(loop);
    };
    if (this.engine?.micOn) { showTrack(); loop(); }
    return { el, dispose: () => { cancelAnimationFrame(st.raf); st.lm?.dispose(); } };
  }

  // ───────────────────────── التدريب ─────────────────────────
  screen_practice({ autoSing = false } = {}) {
    const eng = this.engine;
    const micReady = !!eng?.micOn;
    const S = { attempt: null, view: null, off: [], countdownTimer: null, repTimer: null };
    const cur = h('div', { class: 'poem-cur', lang: 'ar', 'aria-live': 'off' });
    const nxt = h('div', { class: 'poem-next', lang: 'ar' });
    const prog = h('div', { class: 'lineprog' }, h('i'));
    const pos = h('span', { class: 'pos small muted num' });
    const badgeBox = h('span');
    const scanBox = h('div', { class: 'scanbox' });
    const lines = h('div', { class: 'card lines' }, h('div', { class: 'meta' }, pos, badgeBox), cur, scanBox, nxt, prog);
    const canvas = h('canvas', { role: 'img', 'aria-label': 'مسار طبقة المرجع ونقاط صوتك على محور زمني واحد' });
    const dirLabel = h('span');
    const viewcard = h('div', { class: 'card viewcard' }, canvas, h('div', { class: 'viewcap' }, h('span', null, '● جيدة · ■ قريبة · ◆ بعيدة'), dirLabel));
    const mkInd = (lab) => { const el = h('div', { class: 'ind', 'data-state': 'none' }, h('div', { class: 'lab' }, lab), h('div', { class: 'val' }, h('span', { class: 'sym' }, '–'), h('span', { class: 'txt' }, 'لا قياس')), h('div', { class: 'det' }, ' ')); return el; };
    const indP = mkInd('الطبقة'), indT = mkInd('التوقيت'), indD = mkInd('القوة');
    const setInd = (el, state, txt, det = ' ') => { el.dataset.state = state; el.querySelector('.sym').textContent = STATE_SYMBOL[state]; el.querySelector('.txt').textContent = txt; el.querySelector('.det').textContent = det; };
    const indBox = h('div', { class: 'indicators', hidden: !micReady }, indP, indT, indD);
    const hint = h('div', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const hintBar = h('div', { class: 'hintbar', hidden: !micReady }, hint);
    const banner = h('div', { class: 'notice warn', hidden: true });
    const noMic = h('div', { class: 'notice', hidden: micReady }, icon('mic'), h('div', null, 'الميكروفون غير مفعّل. يمكنك الاستماع للشطر، أما التدريب بالتقييم فيتطلب ', h('button', { class: 'link', onclick: () => this.go('setup') }, 'إعداد الميكروفون والمعايرة'), '.'));
    const result = h('div', { class: 'card', hidden: true });
    const cdEl = h('div', { class: 'countdown', hidden: true, 'aria-live': 'assertive' });
    viewcard.append(cdEl, hintBar);
    // لوحة تشخيص مباشرة (للمساعدة في معرفة سبب غياب التقييم): تُظهر ما يلتقطه الميكروفون وحالة المزامنة
    const diag = h('pre', { class: 'small num', dir: 'ltr', style: { whiteSpace: 'pre-wrap', margin: '6px 0 0', textAlign: 'left', fontSize: '11px', opacity: '.85' } }, 'تشخيص: اضغط تشغيل ثم تكلّم');
    const diagBox = h('details', { style: { marginTop: '8px' } }, h('summary', { class: 'small muted' }, 'تشخيص (للمساعدة في حل المشاكل)'), diag);
    viewcard.append(diagBox);
    let lastLive = null, lastDiag = 0;

    // ── تعرّف الكلمات («سمعناك تقول») ──
    const stt = new SpeechListener({ lang: 'ar-SA' });
    const A = { chunks: 0, loud: 0, voiced: 0, maxDb: -120, chunkSec: 0 };   // ما التقطه ميكروفون الصفحة أثناء المحاولة
    S.listening = false; S.sp = null;
    const heardTxt = h('span', { class: 'heard-txt', lang: 'ar', id: 'heard-txt' }, '—');
    const heardLine = h('div', { class: 'heard', 'aria-live': 'polite' }, h('span', { class: 'muted small' }, 'سمعناك تقول: '), heardTxt);
    const wordsBox = h('div', { class: 'wordscmp', lang: 'ar', id: 'words-cmp', hidden: true });
    const sttMsg = h('div', { class: 'small', role: 'status', 'aria-live': 'polite', id: 'stt-msg' });
    const sttToggle = h('button', { class: 'btn', id: 'btn-stt-toggle', 'aria-pressed': 'true' }, 'تعرّف الكلمات: مفعّل');
    const consent = h('div', { class: 'notice warn', id: 'stt-consent', hidden: true });
    const supp = sttSupport();
    const sttActive = () => supp.supported && this.prefs.sttConsent && this.prefs.sttOn;
    const refreshStt = () => {
      sttToggle.setAttribute('aria-pressed', String(!!this.prefs.sttOn));
      sttToggle.textContent = `تعرّف الكلمات: ${this.prefs.sttOn && this.prefs.sttConsent ? 'مفعّل' : 'متوقّف'}`;
      consent.hidden = !(supp.supported && !this.prefs.sttConsent && this.prefs.sttOn);
      if (!supp.supported) sttMsg.textContent = 'هذا المتصفح لا يدعم التعرّف على الكلام — تقييم الكلمات متوقف، والاستماع وتدريب النغمة متاحان. (استعمل Chrome.)';
      else if (!this.prefs.sttOn) sttMsg.textContent = 'تقييم الكلمات متوقف بطلبك؛ النغمة تعمل.';
    };
    consent.append(h('div', null, h('b', null, 'قبل تفعيل تعرّف الكلمات: '), 'عند التفعيل يُرسَل صوت الميكروفون إلى خدمة التعرّف على الكلام في المتصفح (في Chrome: خوادم Google) ليتحوّل إلى نص. تحليل النغمة يبقى محليًّا على جهازك.'),
      h('div', { class: 'row', style: { gap: '8px', marginTop: '6px' } },
        h('button', { class: 'btn primary', id: 'btn-stt-agree', onclick: () => { this.prefs.sttConsent = true; this.prefs.sttOn = true; savePrefs(this.prefs); refreshStt(); } }, 'أوافق وأفعّل'),
        h('button', { class: 'btn', id: 'btn-stt-decline', onclick: () => { this.prefs.sttOn = false; savePrefs(this.prefs); refreshStt(); } }, 'لا، بدون الكلمات')));
    sttToggle.onclick = () => { this.prefs.sttOn = !this.prefs.sttOn; savePrefs(this.prefs); refreshStt(); };
    const lm = eng?.micOn ? levelMeter(eng) : null;
    const mt = eng?.micOn ? micTestWidget(eng) : null;
    const bFree = h('button', { class: 'btn', id: 'btn-free-recite', hidden: !micReady }, icon('mic'), 'سمِّع الشطر (بلا تسجيل مرجعي)');
    const speechCard = h('div', { class: 'card col speechcard', style: { gap: '8px' }, hidden: !micReady },
      h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } }, h('b', null, 'الكلمات'), sttToggle),
      consent, lm ? lm.el : null, sttMsg, h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, bFree),
      h('details', null, h('summary', { class: 'small muted' }, 'اختبار الميكروفون'), mt ? mt.el : null));
    refreshStt();
    const resetSpeech = () => { heardTxt.textContent = '—'; heardTxt.className = 'heard-txt'; wordsBox.hidden = true; wordsBox.replaceChildren(); sttMsg.textContent = ''; S.sp = null; A.chunks = A.loud = A.voiced = 0; A.maxDb = -120; };
    const renderWords = (cmp) => {
      wordsBox.hidden = false;
      const lab = { match: '✓', substitute: '✕', missing: '–', ambiguous: '؟' };
      wordsBox.replaceChildren(...cmp.items.map((it) => h('span', { class: `w ${it.status}`, 'data-status': it.status, title: it.heard ? `سُمعت: ${it.heard}` : 'لم تُسمع' }, `${lab[it.status]} ${it.expected}`)),
        ...cmp.extra.map((x) => h('span', { class: `w extra ${x.status}`, 'data-status': x.status }, `+ ${x.heard}`)));
    };
    const onLevel = (e) => { if (!S.listening) return; const d = e.detail; A.chunks++; A.chunkSec = A.chunkSec || 0.0427; if (d.db > -50) A.loud++; const f = eng.latest; if (f && f.voiced && Number.isFinite(f.f0)) A.voiced++; if (d.db > A.maxDb) A.maxDb = d.db; };
    if (eng) { eng.addEventListener('level', onLevel); S.off.push(() => eng.removeEventListener('level', onLevel)); }
    stt.addEventListener('result', (e) => {
      const sn = e.detail; if (!S.listening) return;
      heardTxt.replaceChildren(h('span', { class: 'fin' }, sn.finalText), sn.finalText && sn.interim ? ' ' : '', h('span', { class: 'int' }, sn.interim));
      if (!heardTxt.textContent.trim()) heardTxt.textContent = '…';
      if (sn.hasFinal && A.loud * 0.0427 >= 0.3) renderWords(compareWords(this.hems[this.idx].text, sn.finalText, { final: true, confidence: sn.confidence }));   // الكلمات تثبت بعد النتيجة النهائية فقط
    });
    stt.addEventListener('error', (e) => { const er = e.detail.error; if (er === 'no-speech' || er === 'aborted') return; sttMsg.textContent = `${STT_ERRORS[er] || `تعذّر التعرّف (${er})`} — تقييم الكلمات متوقف الآن، والنغمة تعمل.`; S.sttError = er; });
    const startListening = () => {
      resetSpeech(); S.sttError = null;
      if (!sttActive()) return false;
      if (!stt.start()) return false;
      S.listening = true; heardTxt.textContent = '… تكلّم'; return true;
    };
    /** يُنهي الاستماع ويقارن بالنص مع حواجز: لا يُنسب لك كلام لم يلتقطه ميكروفونك أو يتسرّب من التسجيل. */
    const finishListening = async ({ withRef = true } = {}) => {
      if (!S.listening) return null;
      const sn = await stt.stop(); S.listening = false;
      const hm = this.hems[this.idx];
      const text = sn.finalText || sn.interim;
      const heardSec = A.loud * 0.0427, voicedSec = A.voiced * 0.0427;
      const leak = !!eng?.status?.().leak?.detected;
      let guard = null;
      if (S.sttError && !text) guard = 'stt-error';
      else if (!text) guard = 'nothing';
      else if (heardSec < 0.3) guard = 'mic-silent';                                   // الخدمة سمعت كلامًا لكن ميكروفون الصفحة صامت
      else if (withRef && (leak || (!this.prefs.headphones && voicedSec < 0.4))) guard = 'reference-leak';   // قد يكون صوت التسجيل لا صوتك
      const cmp = guard === 'mic-silent' || guard === 'reference-leak' || guard === 'nothing' || guard === 'stt-error' ? compareWords(hm.text, '', {}) : compareWords(hm.text, text, { final: sn.hasFinal, confidence: sn.confidence });
      if (!guard) renderWords(cmp); else { wordsBox.hidden = true; wordsBox.replaceChildren(); heardTxt.classList.add('rejected'); }
      S.sp = { text, final: sn.hasFinal, confidence: sn.confidence, cmp, guard, heardSec, voicedSec, leak, hem: hm.index, error: S.sttError || null };
      return S.sp;
    };
    const spNote = (sp) => {
      if (!sp) return null;
      if (sp.guard === 'stt-error') return `خدمة التعرّف تعطّلت: ${STT_ERRORS[sp.error] || sp.error} تقييم الكلمات متوقف؛ الاستماع وتدريب النغمة يعملان.`;
      if (sp.guard === 'nothing') return 'لم تصل كلمات مفهومة من خدمة التعرّف. تكلّم بوضوح وأعد الشطر.';
      if (sp.guard === 'mic-silent') return 'سمعت الخدمة كلامًا لكن ميكروفون الصفحة لم يلتقط صوتك (ربما هو صوت التسجيل) — لم يُنسب إليك.';
      if (sp.guard === 'reference-leak') return 'يبدو أن الميكروفون التقط صوت التسجيل نفسه؛ استعمل سماعات ثم أعد الشطر — لم يُحتسب النص.';
      return describeDiff(sp.cmp);
    };

    // أزرار
    const bPlay = h('button', { class: 'btn primary round', id: 'btn-sing', 'aria-label': 'غنِّ مع التسجيل' }, icon('play'));
    const bListen = h('button', { class: 'btn', id: 'btn-listen-line' }, icon('ear'), 'استمع للشطر');
    const bRestart = h('button', { class: 'btn icon', id: 'btn-restart', 'aria-label': 'إعادة الشطر' }, icon('restart'));
    const rtlTime = this.prefs.timeDir !== 'ltr';   // الأسهم تشير نحو الماضي/المستقبل كما يتجه محور الزمن في الرسم
    const bPrev = h('button', { class: 'btn icon', id: 'btn-prev', 'aria-label': 'الشطر السابق', onclick: () => step(-1) }, icon(rtlTime ? 'next' : 'prev'));
    const bNext = h('button', { class: 'btn icon', id: 'btn-next', 'aria-label': 'الشطر التالي', onclick: () => step(1) }, icon(rtlTime ? 'prev' : 'next'));
    const bRep = h('button', { class: 'btn icon', id: 'btn-repeat', 'aria-pressed': String(!!this.prefs.repeat), 'aria-label': 'تكرار تلقائي', onclick: () => { this.prefs.repeat = !this.prefs.repeat; bRep.setAttribute('aria-pressed', String(this.prefs.repeat)); bRep.style.background = this.prefs.repeat ? 'var(--accent-soft)' : ''; savePrefs(this.prefs); } }, icon('repeat'));
    bRep.style.background = this.prefs.repeat ? 'var(--accent-soft)' : '';
    const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: this.prefs.listenVolume, 'aria-label': 'مستوى الاستماع (لا يؤثر على التقييم)', oninput: () => { this.prefs.listenVolume = +vol.value; savePrefs(this.prefs); eng?.setListenVolume(+vol.value); } });
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'نمط التدريب' },
      h('button', { id: 'mode-line', 'aria-pressed': 'true', onclick: () => setPMode('line') }, 'شطر بشطر'),
      h('button', { id: 'mode-cont', 'aria-pressed': 'false', onclick: () => setPMode('continuous') }, 'متواصل'));
    const setPMode = (m) => { this.practiceMode = m; seg.children[0].setAttribute('aria-pressed', String(m === 'line')); seg.children[1].setAttribute('aria-pressed', String(m === 'continuous')); bPlay.setAttribute('aria-label', m === 'line' ? 'غنِّ مع التسجيل' : 'ابدأ التدريب المتواصل'); bRep.hidden = m !== 'line'; };
    // شريط النقل اللاصق مضغوط (صف واحد) كي تبقى البطاقات والمؤشرات ظاهرة أثناء الغناء على الجوال
    const controls = h('div', { class: 'controls transport' }, ...(rtlTime ? [bPrev, bRestart, bPlay, bNext, bRep] : [bNext, bRestart, bPlay, bPrev, bRep]));
    lines.append(h('div', { class: 'cardfoot' }, bListen));
    const volRow = h('div', { class: 'volrow' }, h('label', { class: 'volume' }, icon('speaker'), h('span', null, 'مستوى الاستماع'), vol));
    const toolLinks = h('div', { class: 'toolrow' },
      h('button', { class: 'link small listen-alt', id: 'link-listen-line', onclick: () => bListen.click() }, icon('ear'), 'استمع للشطر'),   // يظهر بدل زر البطاقة في الشاشات القصيرة
      h('button', { class: 'link small', id: 'link-fix-timing', onclick: () => this.go('editor', { idx: this.idx }) }, icon('edit'), 'صحّح توقيت هذا الشطر'),
      h('button', { class: 'link small', onclick: () => this.go('browse') }, icon('list'), 'فهرس/بحث'),
      h('button', { class: 'link small', onclick: () => this.go('settings') }, icon('gear'), 'الإعدادات'));

    // الجوال: عمود واحد (الشطر ثم الرسم ثم المؤشرات)؛ سطح المكتب: عمودان (الشطر والرسم | المؤشرات والنتيجة) كي تبقى المؤشرات ظاهرة أثناء الغناء
    const el = h('div', { class: 'wrap practice-wrap col' },
      h('div', { class: 'top' }, h('button', { class: 'btn icon ghost', 'aria-label': 'الرئيسية', onclick: () => this.go('home') }, icon('back')), h('h3', { class: 'grow title-wide' }, this.data.poem.title), seg),
      banner, noMic,
      h('div', { class: 'psplit' }, h('div', { class: 'pmain col' }, lines, h('div', { class: 'heardwrap', hidden: !micReady }, heardLine, wordsBox), viewcard), h('div', { class: 'pside col' }, indBox, result, speechCard, volRow, toolLinks)),
      h('div', { class: 'sticky-controls' }, controls));

    // عرض الشطر
    const showHem = (i, { keepView = false } = {}) => {
      const hm = this.hems[i];
      cur.textContent = hm.text; nxt.textContent = this.hems[i + 1]?.text || '— نهاية القصيدة —'; scanBox.replaceChildren(...this.scanNodes(i, { caption: false }));
      pos.replaceChildren(h('span', null, `البيت ${this.d(hm.verseIndex + 1)} من ${this.d(this.ref.a.verses.length)}`), h('span', null, `الشطر ${this.d(hm.index + 1)} من ${this.d(this.hems.length)}`));
      badgeBox.replaceChildren(this.badge(hm));
      prog.firstChild.style.width = '0%';
      if (!keepView && S.view && eng?.state !== 'playing') S.view.setStaticTime(hm.startSec);
    };
    const step = async (d) => { if (eng?.state === 'playing') await eng.pause(); S.attempt = null; this.setIdx(this.idx + d); result.hidden = true; showHem(this.idx); };
    S.view = new PitchView(canvas, { ref: this.ref, engine: eng, getHem: () => this.hems[this.idx], prefs: this.prefs });
    window.__pitchView = S.view;
    dirLabel.textContent = this.prefs.timeDir === 'rtl' ? 'الزمن نحو اليسار ←' : 'الزمن نحو اليمين →';
    S.view.start(prefersReducedMotion());
    showHem(this.idx);
    setPMode(this.practiceMode);

    // العدّ التنازلي
    const countdown = async (n) => {
      if (n <= 0) return;
      cdEl.hidden = false;
      for (let k = n; k >= 1; k--) { cdEl.textContent = this.d(k); await sleep(1000); if (S.cancel) break; }
      cdEl.hidden = true;
    };
    const stopAll = async () => { S.cancel = true; clearTimeout(S.repTimer); cdEl.hidden = true; if (eng?.state === 'playing') await eng.pause(); };
    const isBusy = () => eng?.state === 'playing' || !cdEl.hidden;

    const sing = async () => {
      if (!micReady || !eng.micOn) { toast('فعّل الميكروفون وأكمل المعايرة أولًا.'); return; }
      if (isBusy()) { await stopAll(); return; }
      S.cancel = false; result.hidden = true;
      const hm = this.hems[this.idx];
      await countdown(this.prefs.countdown);
      if (S.cancel) return;
      S.attempt = { mode: this.practiceMode, idx: this.idx, startedRef: Math.max(0, hm.startSec - 0.8) };
      if (this.practiceMode === 'line') startListening(); else resetSpeech();
      try { await eng.play({ startSec: S.attempt.startedRef, endSec: this.practiceMode === 'line' ? hm.endSec : null, reason: this.practiceMode === 'line' ? 'line' : 'continuous' }); }
      catch (e) { toast('تعذّر بدء التشغيل: ' + (e.message || e)); }
    };
    bPlay.onclick = sing;
    bFree.onclick = async () => {
      if (!micReady || !eng.micOn) { toast('فعّل الميكروفون أولًا.'); return; }
      if (S.free) {   // إنهاء التسميع
        S.free = false; bFree.replaceChildren(icon('mic'), 'سمِّع الشطر (بلا تسجيل مرجعي)');
        const sp = await finishListening({ withRef: false });
        const hm = this.hems[this.idx];
        showResult(hm, { overall: null, freeRecite: true }, 'free', sp);
        return;
      }
      if (isBusy()) await stopAll();
      result.hidden = true;
      if (!sttActive()) { sttMsg.textContent = supp.supported ? 'فعّل تعرّف الكلمات (وافق على الإرسال للتفريغ) لاستعمال التسميع.' : sttMsg.textContent; return; }
      S.free = true; bFree.replaceChildren(icon('mic'), 'انتهيت — قارن'); startListening();
    };
    bListen.onclick = async () => {
      if (!eng) { toast('الاستماع للشطر يتطلب تفعيل محرّك الصوت (ابدأ من «ابدأ التدريب»).'); return; }
      if (isBusy()) { await stopAll(); return; }
      S.cancel = false; S.attempt = null; const hm = this.hems[this.idx];
      await eng.play({ startSec: Math.max(0, hm.startSec - 0.5), endSec: hm.endSec, reason: 'listen', scored: false });
    };
    bRestart.onclick = async () => {
      if (!eng) return;
      S.cancel = false; result.hidden = true; const hm = this.hems[this.idx];
      S.attempt = { mode: 'line', idx: this.idx, startedRef: Math.max(0, hm.startSec - 0.8) };
      startListening();
      await eng.play({ startSec: S.attempt.startedRef, endSec: hm.endSec, reason: 'restart-line', scored: micReady && eng.micOn });
    };

    // أحداث المحرّك
    const on = (type, fn) => { if (!eng) return; eng.addEventListener(type, fn); S.off.push(() => eng.removeEventListener(type, fn)); };
    on('state', () => { const playing = eng.state === 'playing'; bPlay.replaceChildren(icon(playing && S.attempt ? 'pause' : 'play')); });
    on('tick', (e) => {
      const t = e.detail.tRef;
      if (diagBox.open && Date.now() - lastDiag > 400) {
        lastDiag = Date.now();
        try {
          const st = eng.status(), f = eng.latest, c = eng.session.cur;
          diag.textContent = [
            `state=${st.state} mic=${st.micOn} muted=${st.micMuted} digitalSilence=${st.digitalSilence} ctx=${st.ctx?.state}@${st.ctx?.sampleRate}`,
            `mic frame: ${f ? `energy=${f.energyDb?.toFixed(1)}dB f0=${f.voiced && Number.isFinite(f.f0) ? f.f0.toFixed(0) + 'Hz' : '-'} voiced=${f.voiced ? 1 : 0} unmeasurable=${f.unmeasurable ? 1 : 0}` : 'none'}`,
            `frames: mic=${c ? c.mic.t.length : 0} tap=${c && c.tap ? c.tap.t.length : '?'}`,
            `sync: delta=${st.sync.delta != null ? st.sync.delta.toFixed(3) : 'null'} count=${st.sync.count} corr=${st.sync.corr != null ? st.sync.corr.toFixed(3) : 'null'} ok=${st.sync.lastOk} reason=${st.sync.lastReason}`,
            `live: absent=${lastLive?.absent} reason=${lastLive?.reason} pitch=${lastLive?.pitch?.state} timing=${lastLive?.timing?.state} level=${lastLive?.level?.state}`,
            `leak: detected=${st.leak.detected} level=${st.leak.monitorLevel != null ? st.leak.monitorLevel.toFixed(2) : '-'} | latency in=${st.latency?.inputSec} out=${st.latency?.outputSec}`,
            `cal: noise=${st.calibration.noiseFloorDb} comfort=${st.calibration.comfortLevelDb} done=${st.calibration.done} | headphones=${st.settings.headphones}`,
            `track: ${st.track ? JSON.stringify(st.track.settings || {}) : '-'}`,
          ].join('\n');
        } catch (er) { diag.textContent = 'diag error: ' + er.message; }
      }
      if (this.practiceMode === 'continuous' && S.attempt && eng.state === 'playing') {
        const i = this.hemIndexAt(t);
        if (i !== this.idx && t >= this.hems[0].startSec) { this.setIdx(i); showHem(i, { keepView: true }); }
      }
      const hm = this.hems[this.idx];
      prog.firstChild.style.width = `${Math.max(0, Math.min(1, (t - hm.startSec) / Math.max(0.1, hm.endSec - hm.startSec))) * 100}%`;
    });
    on('live', (e) => { lastLive = e.detail.live;
      const { live, hint: hn } = e.detail;
      const p = live.pitch, t = live.timing, d = live.level;
      if (live.absent) { setInd(indP, 'none', 'لا صوت', 'لا يُسمع صوتك الآن'); setInd(indT, 'none', 'لا صوت'); setInd(indD, 'none', 'لا صوت'); }
      else {
        setInd(indP, p.state, p.state === 'none' ? 'لا قياس' : p.state === 'ok' ? 'مطابقة' : p.devCents < 0 ? 'أخفض' : 'أعلى', p.devCents != null ? `${fmtNum(p.devCents, 0, this.western)} سنت` : ' ');
        setInd(indT, t.state, t.state === 'none' ? 'لا قياس' : t.state === 'ok' ? 'في الوقت' : t.lagSec > 0 ? 'متأخر' : 'مبكر', t.lagSec != null ? `${fmtNum(t.lagSec, 2, this.western)} ث` : ' ');
        setInd(indD, d.state, d.state === 'none' ? (eng.calibration.done ? 'لا قياس' : 'بلا معايرة') : d.state === 'ok' ? 'مناسبة' : d.devDb < 0 ? 'أخفض' : 'أقوى', d.devDb != null ? `${fmtNum(d.devDb, 0, this.western)} ديسيبل` : ' ');
      }
      hint.textContent = hn ? hn.text : '';
    });
    on('ended', (e) => onEnded(e.detail));
    S.onDevice = null;
    const onDevice = (ev) => {
      if (['mic-ended', 'digital-silence', 'mic-muted', 'ctx-suspended', 'leak-detected'].includes(ev.code)) {
        banner.hidden = false;
        banner.replaceChildren(icon('info'), h('div', null, ev.message || ev.code, ' ', ev.code === 'mic-ended' ? h('button', { class: 'link', onclick: async () => { try { await eng.enableMic(); banner.hidden = true; } catch (er) { toast(er.message); } } }, 'إعادة تشغيل الميكروفون') : null));
      }
    };

    const scoreHem = (hm) => eng.score(hm.startSec, hm.endSec, { alignmentUnreliable: hm.status !== 'manual' });
    const onEnded = async ({ reason }) => {
      const a = S.attempt;
      for (const el of [indP, indT, indD]) setInd(el, 'none', 'لا قياس');   // لا تبقى قيم حيّة قديمة بعد التوقف
      hint.textContent = '';
      if (!a) return;
      S.attempt = null;
      const tEndRef = eng.audio ? eng.audio.currentTime : 0;
      if (a.mode === 'line') {
        const hm = this.hems[a.idx], res = scoreHem(hm);
        const sp = await finishListening({ withRef: true });
        this.results.set(a.idx, { res, at: Date.now(), hem: hm, speech: sp });
        showResult(hm, res, reason, sp);
        this.persistAttempt(hm, res, sp, a.mode).then((st) => { const el = document.getElementById('save-status'); if (el) el.textContent = st; });
        if (this.prefs.repeat && reason === 'range-end' && this.screenName === 'practice') S.repTimer = setTimeout(() => { if (!isBusy() && this.screenName === 'practice') sing(); }, 2200);
      } else {
        if (S.listening) { await stt.stop(); S.listening = false; }
        const items = [];
        const t0 = a.startedRef, t1 = tEndRef;
        for (const hm of this.hems) if (hm.startSec >= t0 + 0.7 && hm.endSec <= t1 + 0.05) { const res = scoreHem(hm); this.results.set(hm.index, { res, at: Date.now(), hem: hm }); items.push({ h: hm, res }); }
        if (items.length) this.go('review', { items, title: 'مراجعة التدريب المتواصل', kind: 'continuous', reason });
        else toast('تدرّبت على أقل من شطر كامل؛ لا مراجعة لهذه المحاولة.');
      }
    };
    const showResult = (hm, res, reason, sp = null) => {
      const s = res.overall, st = stateForScore(s);
      result.hidden = false;
      const notes = res.freeRecite ? [] : notesForHemistich(hm, res, { western: this.western });
      const read = sp ? countsAsRead(sp.cmp) && !sp.guard : null;
      const spLine = !sp ? (sttActive() ? null : h('div', { class: 'small muted' }, 'تقييم الكلمات متوقف (التعرّف غير مفعّل أو غير مدعوم) — يُقاس الأداء الصوتي فقط.'))
        : h('div', { class: 'speech-result', id: 'speech-result' },
            h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
              h('span', { class: `chip ${read ? 'ok' : sp.guard ? 'warn' : 'bad'}`, id: 'read-chip' }, sp.guard ? '؟ لم يُحتسب النص' : read ? '✓ الكلمات مطابقة — قراءة محتسبة' : '✕ الكلمات لا تطابق — لم تُحتسب قراءة'),
              sp.text ? h('span', { class: 'small', lang: 'ar' }, 'سمعناك تقول: ', h('b', null, sp.text)) : null),
            h('div', { class: 'small', id: 'speech-note' }, spNote(sp)),
            sp.cmp.verdict === 'partial' || sp.cmp.items?.some((x) => x.status === 'ambiguous') ? h('div', { class: 'small muted' }, 'النتيجة غير حاسمة — أعد الشطر للتأكد.') : null,
            res.overall != null && !read ? h('div', { class: 'small muted' }, 'النغمة قيست، لكن لا تُحتسب قراءةً للبيت ما لم تطابق الكلمات.') : null);
      if (res.freeRecite) {
        result.replaceChildren(h('div', { class: 'col', style: { gap: '8px' } }, h('b', null, 'نتيجة التسميع (الكلمات فقط)'), spLine || h('div', { class: 'small muted' }, 'لا نص.'), h('button', { class: 'btn primary', onclick: () => bFree.click() }, 'سمِّع مرة أخرى')));
        return;
      }
      result.replaceChildren(
        h('div', { class: 'result-mini' },
          h('div', { class: 'bigscore num', style: { color: `var(--${st === 'none' ? 'none' : st})` } }, s == null ? '—' : fmtPct(s, this.western)),
          h('div', { class: 'grow' }, h('div', { class: 'chip accent' }, SCOPE.label), h('div', { class: 'small muted' }, s == null ? (notes[0]?.text || 'لم يُقَس') : `${STATE_SYMBOL[st]} ${STATE_WORD[st]} · الثقة ${fmtPct(res.confidence?.value, this.western)}${reason !== 'range-end' ? ' · محاولة غير مكتملة' : ''}`)),
          h('button', { class: 'btn', onclick: () => this.go('review', { items: [{ h: hm, res }], title: `مراجعة الشطر ${this.d(hm.index + 1)}`, kind: 'line' }) }, 'التفاصيل'),
          h('button', { class: 'btn primary', onclick: () => sing() }, 'أعد المحاولة')),
        spLine,
        h('div', { class: 'small muted', id: 'save-status' }),
        h('ul', { class: 'notes', style: { marginTop: '12px' } }, notes.slice(0, sp ? 1 : 3).map((n) => h('li', { class: n.severity }, h('span', { class: 'sym' }, n.severity === 'good' ? '✓' : n.severity === 'bad' ? '✕' : n.severity === 'gray' ? '–' : '▲'), n.text))));
      result.classList.add('result-anchor');   // هامش تمرير سفلي يتجاوز الشريط اللاصق
      requestAnimationFrame(() => { try { result.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }); } catch { /* */ } });
    };
    if (autoSing) setTimeout(sing, 50);
    return { el, onDevice, dispose: () => { stt.stopNow(); lm?.dispose(); S.cancel = true; clearTimeout(S.repTimer); S.off.forEach((f) => f()); S.view?.dispose(); if (eng?.state === 'playing') eng.pause(); } };
  }

  // ───────────────────────── المراجعة ─────────────────────────
  screen_review({ items, title = 'المراجعة', kind = 'line', reason = null }) {
    const sum = summarize(items);
    const st = stateForScore(sum.overall);
    const dims = [['pitch', 'الطبقة'], ['timing', 'التوقيت'], ['pauses', 'الوقفات'], ['dynamics', 'القوة']];
    const notes = items.flatMap(({ h: hm, res }) => notesForHemistich(hm, res, { western: this.western }));
    const order = { bad: 0, warn: 1, gray: 2, info: 3, good: 4 };
    notes.sort((a, b) => order[a.severity] - order[b.severity] || a.hemistich - b.hemistich);
    const factors = new Map();
    for (const { res } of items) for (const f of res?.confidence?.factors || []) factors.set(f.label, f.factor);
    const withheld = items.some(({ res }) => res?.overallReason === 'leak-violation');
    const el = h('div', { class: 'wrap col' }, this.top(title, { back: 'practice' }),
      h('div', { class: 'card col' },
        h('div', { class: 'chip accent', style: { alignSelf: 'flex-start' } }, SCOPE.label),
        h('div', { class: 'result-mini' },
          h('div', { class: 'bigscore num', id: 'review-score', style: { color: `var(--${st === 'none' ? 'none' : st})` } }, sum.overall == null ? '—' : fmtPct(sum.overall, this.western)),
          h('div', { class: 'grow' }, h('div', null, sum.overall == null ? (withheld ? 'عُطّل التقييم الرقمي بسبب تسرّب الميكروفون.' : 'لم يُقَس') : `${STATE_SYMBOL[st]} ${STATE_WORD[st]}`),
            h('div', { class: 'small muted' }, `أشطار مقيسة: ${this.d(sum.measured)} · غير مقيسة: ${this.d(sum.unmeasured)}${reason && reason !== 'range-end' && reason !== 'media-ended' ? ` · سبب التوقف: ${reason}` : ''}`))),
        ...dims.map(([k, lab]) => { const v = sum[k]; const s2 = stateForScore(v); return h('div', { class: 'dimrow', 'data-state': s2 }, h('span', null, lab), h('div', { class: 'meter' }, h('i', { style: { width: `${(v ?? 0) * 100}%` } })), h('span', { class: 'num' }, v == null ? '—' : `${STATE_SYMBOL[s2]} ${fmtPct(v, this.western)}`)); }),
        h('details', null, h('summary', null, `الثقة بالتقييم: ${fmtPct(sum.confidence, this.western)} — لماذا؟`),
          h('ul', { class: 'notes' }, factors.size ? [...factors].map(([l, f]) => h('li', { class: 'warn' }, h('span', { class: 'sym' }, '▲'), `${l} (×${this.d(f.toFixed(2))})`)) : h('li', { class: 'good' }, h('span', { class: 'sym' }, '✓'), 'لا عوامل تخفض الثقة.'))),
        h('p', { class: 'tiny muted' }, SCOPE.note, ' الأوزان والعتبات تجريبية لم تُعايَر على بيانات بشرية.')),
      h('div', { class: 'card col' }, h('h3', null, 'ملاحظات من القياس'),
        h('ul', { class: 'notes' }, notes.slice(0, 14).map((n) => h('li', { class: n.severity }, h('span', { class: 'sym' }, n.severity === 'good' ? '✓' : n.severity === 'bad' ? '✕' : n.severity === 'gray' ? '–' : '▲'), n.text)))),
      items.length > 1 ? h('div', { class: 'card' }, h('h3', null, 'الأشطار'), h('ul', { class: 'list' }, items.map(({ h: hm, res }) => {
        const s2 = stateForScore(res?.overall);
        return h('li', null, h('div', { class: 'hitem' }, h('span', { class: 'no' }, this.d(hm.index + 1)), h('span', { class: 't', lang: 'ar' }, hm.text),
          h('span', { class: 'row' }, h('span', { class: `chip ${s2 === 'none' ? '' : s2}` }, `${STATE_SYMBOL[s2]} ${res?.overall == null ? '—' : fmtPct(res.overall, this.western)}`),
            h('button', { class: 'btn', onclick: () => { this.setIdx(hm.index); this.go('practice', { autoSing: true }); } }, 'أعد'))));
      }))) : null,
      h('div', { class: 'controls' }, h('button', { class: 'btn primary', onclick: () => this.go('practice') }, 'متابعة التدريب'), items.length === 1 ? h('button', { class: 'btn', onclick: () => { this.setIdx(items[0].h.index); this.go('practice', { autoSing: true }); } }, 'أعد هذا الشطر') : null));
    return { el };
  }

  // ───────────────────────── الفهرس والبحث ─────────────────────────
  screen_browse() {
    const q = h('input', { type: 'search', placeholder: 'ابحث في نص القصيدة (بلا اعتبار للتشكيل)…', 'aria-label': 'بحث', id: 'search-input' });
    const jump = h('input', { type: 'number', min: 1, max: this.ref.a.verses.length, placeholder: 'رقم البيت', 'aria-label': 'الانتقال إلى بيت', style: { maxWidth: '9rem' } });
    const list = h('ul', { class: 'list', id: 'hemlist' });
    const cnt = h('div', { class: 'small muted' });
    const render = () => {
      const needle = normalizeAr(q.value.trim());
      const rows = this.hems.filter((hm) => !needle || normalizeAr(hm.text).includes(needle)).slice(0, 200);
      cnt.textContent = needle ? `${this.d(rows.length)} نتيجة` : `${this.d(this.hems.length)} شطرًا`;
      list.replaceChildren(...rows.map((hm) => {
        const r = this.results.get(hm.index);
        return h('li', null, h('button', { class: 'hitem', onclick: () => { this.setIdx(hm.index); this.go(this.engine?.micOn ? 'practice' : 'setup'); } },
          h('span', { class: 'no' }, this.d(hm.index + 1)), h('span', { class: 't', lang: 'ar' }, hm.text),
          h('span', { class: 'row' }, this.badge(hm), r?.res?.overall != null ? h('span', { class: `chip ${stateForScore(r.res.overall)}` }, fmtPct(r.res.overall, this.western)) : null)));
      }));
    };
    q.oninput = render;
    jump.onchange = () => { const v = (+jump.value) - 1; if (v >= 0 && v < this.ref.a.verses.length) { this.setIdx(v * 2); this.go(this.engine?.micOn ? 'practice' : 'setup'); } };
    // تصدير/استيراد التوقيتات
    const fileIn = h('input', { type: 'file', accept: 'application/json', hidden: true, onchange: async () => {
      try { const o = importTimings(this.data.analysis, await fileIn.files[0].text()); this.overrides = o; saveOverrides(this.data.analysis, o); this.refreshHems(); render(); toast('تم استيراد التوقيتات.'); } catch (e) { toast('تعذّر الاستيراد: ' + e.message, 6000); }
    } });
    const exp = () => { const blob = new Blob([exportTimings(this.data.analysis, this.overrides)], { type: 'application/json' }); const a = h('a', { href: URL.createObjectURL(blob), download: 'karaoke-timings.json' }); document.body.append(a); a.click(); a.remove(); };
    render();
    const el = h('div', { class: 'wrap col' }, this.top('فهرس الأبيات'),
      h('div', { class: 'card col' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, q), jump), cnt,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: exp }, 'تصدير التوقيتات'), h('button', { class: 'btn', onclick: () => fileIn.click() }, 'استيراد توقيتات'), fileIn)),
      h('div', { class: 'card' }, list));
    return { el };
  }

  // ───────────────────────── محرّر التوقيت ─────────────────────────
  screen_editor({ idx }) {
    this.setIdx(idx);
    const hm = this.hems[idx];
    const pl = new PlainPlayer(this.data.audioUrl);
    const st = { start: hm.startSec, end: hm.endSec };
    const canvas = h('canvas', { class: 'editorcv', role: 'img', 'aria-label': 'منحنى طاقة الصوت حول الشطر مع مقبضَي البداية والنهاية' });
    const info = h('div', { class: 'small muted num' });
    const stat = h('div');
    let ed;
    const refresh = () => { info.textContent = `البداية ${this.ft(st.start)} · النهاية ${this.ft(st.end)} · المدة ${fmtNum(st.end - st.start, 2, this.western)} ث`; };
    const cur = this.hems[idx];
    stat.replaceChildren(this.badge(cur), h('span', { class: 'small muted' }, cur.status === 'manual' ? ' صحّحتَه بنفسك.' : ' محسوبة من بنية الصوت وليست محقّقة لفظيًا.'));
    setTimeout(() => {
      ed = new TimingEditor(canvas, { ref: this.ref, hem: hm, prefs: this.prefs, onChange: (s, e2) => { st.start = s; st.end = e2; refresh(); } });
      pl.onTick = (t) => ed.setPlayhead(t);
      refresh();
    }, 0);
    const nudge = (which, dt) => { const t = (which === 'start' ? st.start : st.end) + dt; ed.nudgeTo(which, Math.round(t * 100) / 100); st.start = ed.start; st.end = ed.end; refresh(); };
    const nb = (which, label, dt) => h('button', { class: 'btn', onclick: () => nudge(which, dt) }, label);
    const save = () => {
      const o = this.overrides; o.hemistichs[hm.id] = { startSec: st.start, endSec: st.end, status: 'manual' };
      // ربط المجاور: إن كان الشطر التالي ملاصقًا فتتحرّك بدايته مع نهاية هذا
      const nx = this.hems[idx + 1];
      if (linkBox.checked && nx && Math.abs(nx.startSec - hm.endSec) < 0.25 && st.end < nx.endSec - 0.3) o.hemistichs[nx.id] = { startSec: st.end, endSec: nx.endSec, status: 'manual' };
      const pv = this.hems[idx - 1];
      if (linkBox.checked && pv && Math.abs(pv.endSec - hm.startSec) < 0.25 && st.start > pv.startSec + 0.3) o.hemistichs[pv.id] = { startSec: pv.startSec, endSec: st.start, status: 'manual' };
      saveOverrides(this.data.analysis, o); this.refreshHems(); toast('حُفظ التوقيت (مصحَّح يدويًا).'); this.go('editor', { idx });
    };
    const reset = () => { delete this.overrides.hemistichs[hm.id]; saveOverrides(this.data.analysis, this.overrides); this.refreshHems(); toast('أُعيد التوقيت التلقائي.'); this.go('editor', { idx }); };
    const linkBox = h('input', { type: 'checkbox', checked: true, id: 'link-neighbors' });
    // ضبط بالنقر
    const tap = { on: false, i: idx, marks: new Map() };
    const tapInfo = h('div', { class: 'small muted' });
    const tapBtn = h('button', { class: 'btn primary big', hidden: true, onclick: () => { tap.marks.set(tap.i, pl.t); tapInfo.textContent = `سُجّلت بداية الشطر ${this.d(tap.i + 1)} عند ${this.ft(pl.t)}`; tap.i++; if (tap.i >= this.hems.length) finishTap(); } }, 'يبدأ الشطر التالي الآن');
    const finishTap = () => { pl.stop(); tapBtn.hidden = true; const ids = [...tap.marks.keys()].sort((a, b) => a - b); let n = 0; for (let k = 0; k < ids.length - 1; k++) { const a = ids[k], b = ids[k + 1]; if (b === a + 1 && tap.marks.get(b) > tap.marks.get(a) + 0.3) { this.overrides.hemistichs[this.hems[a].id] = { startSec: tap.marks.get(a), endSec: tap.marks.get(b), status: 'manual' }; n++; } } saveOverrides(this.data.analysis, this.overrides); this.refreshHems(); toast(`حُفظ ${this.d(n)} توقيتًا من النقر.`); this.go('editor', { idx }); };
    const startTap = async () => { tap.on = true; tap.i = idx; tap.marks.clear(); tapBtn.hidden = false; tapInfo.textContent = 'اضغط الزر عند بدء كل شطر. اضغط «إنهاء» حين تريد التوقف.'; await pl.playRange(Math.max(0, this.hems[idx].startSec - 1.5)); };
    const el = h('div', { class: 'wrap col' }, this.top(`تصحيح توقيت الشطر ${this.d(idx + 1)}`, { back: 'practice' }),
      h('div', { class: 'card col' }, h('div', { class: 'poem-cur', lang: 'ar', style: { minHeight: 'auto', fontSize: 'calc(var(--poem-size) * .8)' } }, hm.text), stat,
        h('div', { class: 'notice' }, icon('info'), h('div', null, 'اسحب المقبضَين على منحنى الطاقة، أو استعمل الأزرار للضبط الدقيق، ثم اضغط «استمع» للتحقق بأذنك. حدود الشطر هنا مقدّرة من بنية الصوت وليست مُحقَّقة لفظيًا.')),
        canvas, info,
        h('div', { class: 'toolrow' }, nb('start', 'البداية −٠٫١', -0.1), nb('start', '−٠٫٠١', -0.01), nb('start', '+٠٫٠١', 0.01), nb('start', '+٠٫١', 0.1)),
        h('div', { class: 'toolrow' }, nb('end', 'النهاية −٠٫١', -0.1), nb('end', '−٠٫٠١', -0.01), nb('end', '+٠٫٠١', 0.01), nb('end', '+٠٫١', 0.1)),
        h('label', { class: 'switch' }, h('span', null, 'حرّك حدود الشطر المجاور الملاصق معه'), linkBox),
        h('div', { class: 'toolrow' }, h('button', { class: 'btn', onclick: () => pl.playRange(Math.max(0, st.start - 0.3), st.end + 0.2) }, icon('ear'), 'استمع للمقطع'), h('button', { class: 'btn', onclick: () => pl.stop() }, 'إيقاف'),
          h('button', { class: 'btn primary', id: 'btn-save-timing', onclick: save }, 'تثبيت التوقيت'), hm.status === 'manual' ? h('button', { class: 'btn danger', onclick: reset }, 'إرجاع للتلقائي') : null)),
      h('div', { class: 'card col' }, h('h3', null, 'ضبط بالنقر (اختياري)'), h('p', { class: 'small muted' }, 'يُشغَّل التسجيل من هذا الشطر وتضغط عند بدء كل شطر؛ تُحفظ الأوقات كتصحيحات يدوية.'),
        h('div', { class: 'toolrow' }, h('button', { class: 'btn', onclick: startTap }, 'ابدأ الضبط بالنقر'), h('button', { class: 'btn', onclick: finishTap }, 'إنهاء وحفظ')), tapBtn, tapInfo),
      h('div', { class: 'controls' }, h('button', { class: 'btn', onclick: () => this.go('editor', { idx: Math.max(0, idx - 1) }) }, 'الشطر السابق'), h('button', { class: 'btn', onclick: () => this.go('editor', { idx: Math.min(this.hems.length - 1, idx + 1) }) }, 'الشطر التالي')));
    return { el, dispose: () => { pl.dispose(); ed?.dispose(); } };
  }

  // ───────────────────────── الإعدادات ─────────────────────────
  screen_settings() {
    const eng = this.engine, P = this.prefs;
    const sel = (key, opts, after) => h('select', { onchange: (e) => { P[key] = e.target.value; this.save(); after?.(); } }, opts.map(([v, l]) => h('option', { value: v, selected: P[key] === v }, l)));
    const field = (label, ctl, hint) => h('div', { class: 'field' }, h('label', null, label), ctl, hint ? h('div', { class: 'tiny muted' }, hint) : null);
    const man = h('input', { type: 'range', min: -300, max: 300, step: 5, value: P.manualMs, oninput: () => { P.manualMs = +man.value; manV.textContent = `${this.d(P.manualMs)} م.ث`; savePrefs(P); eng?.setManualOffset(P.manualMs / 1000); } });
    const manV = h('span', { class: 'num small' }, `${this.d(P.manualMs)} م.ث`);
    const cd = h('select', { id: 'sel-countdown', onchange: (e) => { P.countdown = +e.target.value; savePrefs(P); } }, [0, 1, 2, 3, 5].map((n) => h('option', { value: n, selected: P.countdown === n }, n === 0 ? 'بلا عدّ' : `${this.d(n)} ثوانٍ`)));
    const st = eng ? eng.status() : null;
    const log = h('pre', { class: 'log' }, st ? JSON.stringify({ status: st, events: eng.events.slice(-40) }, null, 1) : 'المحرّك لم يُشغَّل بعد.');
    const el = h('div', { class: 'wrap col' }, this.top('الإعدادات'),
      h('div', { class: 'card col' }, h('h3', null, 'التقييم'),
        field('وضع المزامنة', sel('mode', [['strict', 'صارم: المقارنة عند موضع المرجع بعد تعويض التأخير فقط'], ['tolerant', 'متسامح: يسمح بإزاحة محلية صغيرة (≤ ٠٫٣ ث) في مقارنة الطبقة']], () => eng?.setMode(P.mode)), 'في الوضعين يبقى خطأ التوقيت ظاهرًا ومحسوبًا.'),
        field('ضبط التأخير يدويًا', h('div', { class: 'row' }, man, manV), 'يُضاف إلى تقدير كمون الجهاز. موجب = كأنك تسمع متأخرًا فتُقارَن بموضع مرجعي أبكر.'),
        field('العدّ التنازلي قبل الغناء', cd)),
      h('div', { class: 'card col' }, h('h3', null, 'العرض'),
        field('اتجاه محور الزمن في الرسم', sel('timeDir', [['rtl', 'نحو اليسار (يوافق قراءة العربية)'], ['ltr', 'نحو اليمين']]), 'ثابت ولا يتغيّر تلقائيًا مع اتجاه الصفحة.'),
        field('السمة', sel('theme', [['auto', 'تلقائي'], ['light', 'فاتح'], ['dark', 'داكن']], () => applyPrefs(P))),
        field('الحركة', sel('motion', [['auto', 'حسب النظام'], ['reduce', 'تقليل الحركة'], ['full', 'كاملة']], () => applyPrefs(P))),
        field('التباين', sel('contrast', [['normal', 'عادي'], ['high', 'عالٍ']], () => applyPrefs(P))),
        field('حجم نص الشعر', sel('size', [['normal', 'عادي'], ['large', 'كبير']], () => applyPrefs(P))),
        field('الأرقام', sel('digits', [['arabic', 'هندية (٠١٢)'], ['western', 'لاتينية (012)']]))),
      h('div', { class: 'card col' }, h('h3', null, 'التوقيتات'),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => this.go('browse') }, 'تصدير/استيراد من الفهرس'), h('button', { class: 'btn danger', onclick: () => { this.overrides.hemistichs = {}; saveOverrides(this.data.analysis, this.overrides); this.refreshHems(); toast('حُذفت كل التصحيحات اليدوية.'); } }, 'حذف كل التصحيحات اليدوية'))),
      videoCard({ audioUrl: this.data.audioUrl }),
      h('div', { class: 'card col' }, h('h3', null, 'تشخيص'), h('details', null, h('summary', null, 'حالة المحرّك وسجل الأحداث'), log),
        h('p', { class: 'tiny muted' }, `بصمة الصوت ${this.data.analysis.audioHash.slice(0, 12)}… · بصمة النص ${this.data.analysis.textHash.slice(0, 12)}… · إصدار التحليل ${this.data.analysis.analysisVersion}`)));
    return { el };
  }

  // ───────────────────────── كيف يعمل ─────────────────────────
  /** حفظ المحاولة في قاعدتك (للمسجَّل فقط) — نتيجة فقط؛ لا تسجيل صوتي يُرفع هنا. يعيد نصًا لحالة الحفظ. */
  async persistAttempt(hm, res, sp, mode) {
    if (!this.cloud.configured) return 'الحفظ السحابي غير مُعدّ.';
    if (!this.cloud.user) return 'سجّل الدخول من «حسابي وتدريباتي» لحفظ تقدمك بين الأجهزة.';
    const measurable = res.overall != null && !!sp && !sp.guard;
    const rec = { client_attempt_id: uuid(), poem_id: 'saif-asdaq', hem_id: `h${hm.index}`, hem_index: hm.index, mode,
      overall: res.overall ?? null, pitch_score: res.pitch ?? null, timing_score: res.timing ?? null,
      heard_text: sp?.text || null, words_verdict: sp?.cmp?.verdict || null, words_json: sp && !sp.guard ? sp.cmp.items.map((x) => ({ expected: x.expected, expectedNorm: x.expectedNorm, heard: x.heard, status: x.status })) : null,
      read_counted: !!sp && !sp.guard && countsAsRead(sp.cmp), measurable, scoring_engine: 'v1-pitch-timing', speech_engine: 'webspeech-ar-SA' };
    try { const r = await this.cloud.saveAttempt(rec); return r.status === 'saved' ? 'حُفظت المحاولة في حسابك ✓' : r.status === 'queued' ? 'لم تُحفظ بعد (لا اتصال) — ستُرسل تلقائيًا ولن تتكرر.' : 'ضيف: لم تُحفظ.'; }
    catch (e) { return `تعذّر الحفظ: ${e.message}`; }
  }

  screen_account() {
    const c = this.cloud, box = h('div', { class: 'col', style: { gap: '12px' } });
    const el = h('div', { class: 'wrap col' }, this.top('حسابي وتدريباتي'), box);
    const render = async () => {
      if (!c.configured) { box.replaceChildren(h('div', { class: 'card col' }, h('b', null, 'الحفظ السحابي غير مُعدّ في هذه النسخة'), h('p', { class: 'small muted' }, 'التدريب والاستماع يعملان كضيف. لتفعيل الحسابات ضع رابط مشروع Supabase والمفتاح العلني في data/cloud-config.json (انظر HANDOFF.md).'))); return; }
      if (!c.user) {
        const em = h('input', { type: 'email', id: 'acc-email', dir: 'ltr', autocomplete: 'email', placeholder: 'البريد الإلكتروني', style: { padding: '10px', borderRadius: '10px' } });
        const pw = h('input', { type: 'password', id: 'acc-pass', dir: 'ltr', autocomplete: 'current-password', placeholder: 'كلمة المرور (٨ أحرف فأكثر)', style: { padding: '10px', borderRadius: '10px' } });
        const msg = h('div', { class: 'small', role: 'status', id: 'acc-msg' });
        const run = (fn) => async (ev) => { const b = ev.currentTarget; b.disabled = true; msg.textContent = '…'; try { const r = await fn(); if (r?.needsConfirm) msg.textContent = 'أُنشئ الحساب. افتح رابط التأكيد في بريدك ثم سجّل الدخول.'; else render(); } catch (e) { msg.textContent = e.kind === 'network' ? 'تعذّر الاتصال بالخادم — جرّب لاحقًا.' : `لم ينجح: ${e.message}`; } finally { b.disabled = false; } };
        box.replaceChildren(h('div', { class: 'card col' }, h('b', null, 'سجّل الدخول لحفظ تقدمك بين الأجهزة'), h('div', { class: 'small muted' }, 'يمكنك الاستماع والتدريب كضيف دون حساب. الحساب يحفظ نتائج محاولاتك فقط، لا تسجيلاتك.'), em, pw,
          h('div', { class: 'row', style: { gap: '8px' } }, h('button', { class: 'btn primary', id: 'btn-login', onclick: run(() => c.signIn(em.value.trim(), pw.value)) }, 'دخول'), h('button', { class: 'btn', id: 'btn-signup', onclick: run(() => c.signUp(em.value.trim(), pw.value)) }, 'إنشاء حساب')), msg));
        return;
      }
      box.replaceChildren(h('div', { class: 'card col' }, h('div', null, 'الحساب: ', h('b', { dir: 'ltr' }, c.user.email || c.user.id)), h('div', { class: 'small muted', id: 'pending-n' }, c.pending.length ? `محاولات بانتظار الإرسال: ${this.d(c.pending.length)}` : ''),
        h('button', { class: 'btn', id: 'btn-logout', onclick: async () => { await c.signOut(); render(); } }, 'تسجيل الخروج')), h('div', { class: 'card', id: 'mine' }, 'يُحمَّل تقدّمك…'));
      try {
        await c.flush(); const rows = await c.listAttempts(); const sm = summarizeAttempts(rows); const mine = box.querySelector('#mine');
        if (!rows.length) { mine.replaceChildren(h('div', { class: 'muted' }, 'لا محاولات محفوظة بعد. تدرّب على شطر وستظهر هنا.')); return; }
        const L = sm.lastAttempt;
        mine.replaceChildren(h('h3', null, 'تدريباتي'),
          h('div', { id: 'mine-last' }, `آخر موضع: الشطر ${this.d((L.hem_index ?? 0) + 1)}${L.created_at && !isNaN(new Date(L.created_at)) ? ' — ' + new Date(L.created_at).toLocaleString('ar-SA') : ''}`, h('button', { class: 'btn small', style: { marginInlineStart: '8px' }, onclick: () => { this.setIdx(L.hem_index ?? 0); this.go(this.engine?.micOn ? 'practice' : 'setup'); } }, 'تابع من هنا')),
          h('div', { class: 'small', id: 'mine-count' }, `عدد المحاولات: ${this.d(rows.length)}`),
          h('ul', { id: 'mine-hems' }, sm.hems.map((e) => h('li', null, `الشطر ${this.d((e.hem_index ?? 0) + 1)}: ${this.d(e.attempts)} محاولة · آخر نتيجة ${e.last.overall != null ? this.d(Math.round(e.last.overall * 100)) + '٪' : 'غير مقيسة'}`))),
          h('h3', null, 'راجع كلماتي'), sm.wordsToReview.length ? h('ul', { id: 'mine-words', lang: 'ar' }, sm.wordsToReview.map((w) => h('li', null, h('b', null, w.word), ` — احتاجت إعادة ${this.d(w.n)} مرة`, h('button', { class: 'btn small', style: { marginInlineStart: '8px' }, onclick: () => { const i = Number(w.hem_id.slice(1)); this.setIdx(i); this.go(this.engine?.micOn ? 'practice' : 'setup'); } }, 'تدرّب')))) : h('div', { class: 'muted small' }, 'لا كلمات تحتاج مراجعة (أو لا قياس كافٍ بعد).'));
      } catch (e) { box.querySelector('#mine').textContent = e.kind === 'network' ? 'تعذّر تحميل تقدمك الآن (لا اتصال). محاولاتك المعلّقة ستُرسل تلقائيًا.' : `تعذّر التحميل: ${e.message}`; }
    };
    render();
    return { el, dispose: () => {} };
  }

  screen_about() {
    const a = this.data.analysis;
    const warns = a.qualityWarnings.map((w) => h('li', null, h('b', null, w.code || w.id || ''), ' — ', w.message || w.text || ''));
    const el = h('div', { class: 'wrap col' }, this.top('كيف يعمل؟'),
      h('div', { class: 'card col' }, h('h3', null, 'ما الذي يُقاس'),
        h('p', null, 'يقارن التطبيق صوتك لحظةً بلحظة بتحليل مسبق لتسجيل مرجعي: ', h('b', null, 'الطبقة'), ' (بالسنت، مع إزاحة راحة ثابتة)، ', h('b', null, 'التوقيت'), ' (البدايات والمدود)، ', h('b', null, 'الوقفات'), '، و', h('b', null, 'القوة'), ' نسبةً لمستوى معايرتك.'),
        h('div', { class: 'notice warn' }, icon('info'), h('div', null, h('b', null, SCOPE.label), ' فقط. ', SCOPE.note)),
        h('p', null, 'الدندنة بنفس اللحن قد تنال تشابهًا لحنيًا مرتفعًا؛ التطبيق لا يتحقق من أنك نطقت الكلمات.')),
      h('div', { class: 'card col' }, h('h3', null, 'حدود التحليل المسبق'),
        h('ul', null, h('li', null, 'حدود الأشطار مقدَّرة من بنية الصوت (انخفاضات الطاقة وإيقاع الأبيات) وليست محقَّقة بالتعرّف على الكلمات. صحّحها يدويًا عند الحاجة.'),
          h('li', null, 'لم تُقَس أزمنة الكلمات؛ لذلك لا يُلوَّن النص كلمةً بكلمة.'),
          h('li', null, 'الأوزان والعتبات تجريبية ولم تُعايَر على بيانات بشرية.')),
        h('details', null, h('summary', null, 'تحذيرات جودة ملف التحليل'), h('ul', null, warns))),
      h('div', { class: 'card col' }, h('h3', null, 'الخصوصية'), h('p', null, 'يعمل التحليل كله داخل متصفحك. لا يُسجَّل صوتك ولا يُرسَل إلى أي خدمة. ميزة الفيديو الاختيارية تتصل بخادم محلي على جهازك فقط وعند طلبك.')));
    return { el };
  }
}
