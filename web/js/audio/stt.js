// تعرّف الكلام عبر واجهة المتصفح (Web Speech API). في Chrome يُرسَل الصوت إلى خدمة Google للتفريغ؛ لذلك لا يبدأ إلا بعد موافقة صريحة.
// لا نمرّر أي نص متوقَّع ولا قواعد (grammars) للمحرّك، كي لا نحيّزه نحو القصيدة.
export function sttSupport() {
  const C = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  return { supported: !!C, ctor: C || null };
}

export class SpeechListener extends EventTarget {
  constructor({ lang = 'ar-SA', Ctor = null } = {}) {
    super(); this.lang = lang; this.Ctor = Ctor || sttSupport().ctor; this.rec = null; this.running = false;
    this.finals = []; this.interim = ''; this.lastError = null;
  }
  get supported() { return !!this.Ctor; }
  _emit(t, d) { this.dispatchEvent(new CustomEvent(t, { detail: d })); }
  start() {
    if (!this.Ctor) { this.lastError = 'unsupported'; this._emit('error', { error: 'unsupported' }); return false; }
    this.stopNow(); this.finals = []; this.interim = ''; this.lastError = null; this.startedAt = Date.now();
    const r = new this.Ctor();
    r.lang = this.lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 3;
    r.onstart = () => { this.running = true; this._emit('start', {}); };
    r.onaudiostart = () => this._emit('audiostart', {});
    r.onspeechstart = () => this._emit('speechstart', {});
    r.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i], alt = res[0];
        if (res.isFinal) { this.finals.push({ text: alt.transcript.trim(), confidence: typeof alt.confidence === 'number' && alt.confidence > 0 ? alt.confidence : null, alts: [...res].map((a) => a.transcript.trim()) }); }
        else interim += alt.transcript;
      }
      this.interim = interim.trim();
      this._emit('result', this.snapshot());
    };
    r.onerror = (ev) => { this.lastError = ev.error; this._emit('error', { error: ev.error, message: ev.message }); };
    r.onend = () => { this.running = false; this._emit('end', this.snapshot()); };
    this.rec = r;
    try { r.start(); } catch (e) { this.lastError = e.message; this._emit('error', { error: 'start-failed', message: e.message }); return false; }
    return true;
  }
  snapshot() {
    const finalText = this.finals.map((f) => f.text).join(' ').trim();
    const confs = this.finals.map((f) => f.confidence).filter((c) => c != null);
    return { finalText, interim: this.interim, confidence: confs.length ? Math.min(...confs) : null, hasFinal: this.finals.length > 0, error: this.lastError };
  }
  /** يوقف الاستماع وينتظر النتيجة النهائية (حتى مهلة قصيرة). */
  stop(timeoutMs = 2500) {
    return new Promise((resolve) => {
      if (!this.rec || !this.running) { resolve(this.snapshot()); return; }
      const done = () => { clearTimeout(t); this.removeEventListener('end', done); resolve(this.snapshot()); };
      const t = setTimeout(done, timeoutMs);
      this.addEventListener('end', done);
      try { this.rec.stop(); } catch { done(); }
    });
  }
  stopNow() { try { this.rec?.abort(); } catch { /* */ } this.rec = null; this.running = false; }
}

export const STT_ERRORS = {
  'not-allowed': 'رُفض إذن التعرّف على الكلام أو الميكروفون للمتصفح.',
  'service-not-allowed': 'خدمة التعرّف على الكلام غير مسموحة في هذا المتصفح/السياق.',
  'network': 'تعذّر الاتصال بخدمة التعرّف على الكلام (إنترنت).',
  'no-speech': 'لم تسمع الخدمة كلامًا.',
  'audio-capture': 'لم تلتقط الخدمة الميكروفون.',
  'unsupported': 'هذا المتصفح لا يدعم التعرّف على الكلام (استعمل Chrome).',
  'language-not-supported': 'اللغة العربية غير مدعومة في هذه الخدمة.',
};
