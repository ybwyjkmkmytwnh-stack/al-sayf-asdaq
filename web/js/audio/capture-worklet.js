// AudioWorkletProcessor: يلتقط الميكروفون (المدخل 0) ونسخة المرجع قبل مقياس الصوت (المدخل 1) بعينات float كاملة.
// لا يعالج شيئًا هنا (لا طبقة ولا طاقة): يجمّع كتلًا ويرسلها مع فهرس إطار السياق الدقيق لأول عينة،
// فيبقى زمن كل عينة معروفًا بدقة (frame0 / sampleRate) مهما تأخرت الرسائل.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunk = options?.processorOptions?.chunk || 2048;
    this._alloc();
    this.port.onmessage = (e) => { if (e.data?.type === 'flush') this._flush(); };
  }
  _alloc() {
    this.mic = new Float32Array(this.chunk);
    this.tap = new Float32Array(this.chunk);
    this.n = 0;
    this.frame0 = 0;
    this.micPresent = false;
    this.micMaxAbs = 0;
  }
  _flush() {
    if (this.n === 0) return;
    const mic = this.mic.buffer, tap = this.tap.buffer, n = this.n;
    this.port.postMessage({
      type: 'chunk', frame0: this.frame0, n, mic, tap, micPresent: this.micPresent, micMaxAbs: this.micMaxAbs,
      ctxRate: sampleRate,
    }, [mic, tap]);
    this._alloc();
  }
  process(inputs) {
    const mic = inputs[0] && inputs[0][0];
    const tapCh = inputs[1] || [];
    const len = (mic && mic.length) || (tapCh[0] && tapCh[0].length) || 128;
    if (this.n === 0) this.frame0 = currentFrame;
    for (let i = 0; i < len; i++) {
      const m = mic ? mic[i] : 0;
      this.mic[this.n + i] = m;
      const a = m < 0 ? -m : m;
      if (a > this.micMaxAbs) this.micMaxAbs = a;
      let t = 0;
      for (let c = 0; c < tapCh.length; c++) t += tapCh[c][i];
      this.tap[this.n + i] = tapCh.length ? t / tapCh.length : 0;
    }
    if (mic) this.micPresent = true;
    this.n += len;
    if (this.n + 128 > this.chunk) this._flush();
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
