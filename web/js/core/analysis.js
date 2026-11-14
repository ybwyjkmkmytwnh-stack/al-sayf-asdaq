// تحميل ملف التحليل المرجعي والتحقق منه ومطابقته للصوت، وتوقيتات الأشطار الفعلية (مع التصحيح اليدوي).
import { sha256HexSync } from './sha256.js';

export class AnalysisMismatchError extends Error {
  constructor(code, message) { super(message); this.name = 'AnalysisMismatchError'; this.code = code; }
}

/** SHA-256 (hex). يستعمل crypto.subtle إن توفّر (صفحة آمنة/localhost) وإلا تنفيذ جافاسكربت خالص مُختبَر. */
export async function sha256Hex(buffer) {
  if (globalThis.crypto?.subtle?.digest) {
    const d = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256HexSync(buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer);
}

/** بصمة النص كما في التحليل: SHA-256 لـ UTF-8 من الأشطار مفصولة بـ \n. */
export async function poemTextHash(lines) {
  return sha256Hex(new TextEncoder().encode(lines.join('\n')));
}

/** تنزيل بتقدّم حقيقي (بايتات مستلمة/الإجمالي إن عُرف). */
export async function fetchWithProgress(url, onProgress, { signal } = {}) {
  const resp = await fetch(url, { signal, cache: 'no-cache' });
  if (!resp.ok) throw new Error(`تعذّر تنزيل ${url} (HTTP ${resp.status})`);
  const total = Number(resp.headers.get('content-length')) || 0;
  if (!resp.body || !resp.body.getReader) {
    const buf = await resp.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength || total);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED = ['schemaVersion', 'audioHash', 'textHash', 'analysisVersion', 'durationSec', 'sampleRate', 'hopSec',
  'timeOrigin', 'settings', 'frames', 'segments', 'verses', 'words', 'qualityWarnings'];
const COLS = ['f0Hz', 'voiced', 'voicingProbability', 'pitchQuality', 'energyDb', 'valid', 'invalidReason'];

/** تحقق بنيوي مطابق لـ refkit/schema.py (أهم الفحوص). يعيد مصفوفة أخطاء. */
export function validateAnalysisShape(a) {
  const errs = [];
  if (!a || typeof a !== 'object') return ['ملف التحليل ليس كائنًا'];
  for (const k of REQUIRED) if (!(k in a)) errs.push(`حقل مفقود: ${k}`);
  if (errs.length) return errs;
  if (!HEX64.test(a.audioHash)) errs.push('audioHash غير صالح');
  if (!HEX64.test(a.textHash)) errs.push('textHash غير صالح');
  for (const k of ['durationSec', 'sampleRate', 'hopSec']) if (!(Number.isFinite(a[k]) && a[k] > 0)) errs.push(`${k} غير صالح`);
  if (!Number.isFinite(a.timeOrigin)) errs.push('timeOrigin غير صالح');
  const n = a.frames?.count;
  if (!Number.isInteger(n) || n <= 0) errs.push('frames.count غير صالح');
  else for (const c of COLS) {
    const col = a.frames.columns?.[c];
    if (!Array.isArray(col)) errs.push(`عمود مفقود: ${c}`);
    else if (col.length !== n) errs.push(`طول ${c} ≠ count`);
  }
  if (!Array.isArray(a.verses) || !a.verses.length) errs.push('verses فارغة');
  else {
    let prev = -1;
    for (const v of a.verses) {
      if (!(v.startSec < v.endSec)) errs.push(`بيت ${v.id}: بداية ≥ نهاية`);
      if (v.startSec < prev - 1e-9) errs.push(`بيت ${v.id}: تداخل`);
      prev = v.endSec;
      if (!Array.isArray(v.hemistichs) || v.hemistichs.length !== 2) errs.push(`بيت ${v.id}: يجب شطران`);
    }
  }
  return errs;
}

/** يرفض التحليل إن لم يطابق الصوت/النص المحمّلين. */
export function assertAnalysisMatches(a, { audioHash, textHash }) {
  const errs = validateAnalysisShape(a);
  if (errs.length) throw new AnalysisMismatchError('schema', 'ملف التحليل غير صالح: ' + errs[0]);
  if (audioHash && a.audioHash !== audioHash) {
    throw new AnalysisMismatchError('audio-hash',
      'ملف التحليل لا يطابق ملف الصوت المرفق (بصمة SHA-256 مختلفة). أعد توليده بالأمر: python3 analysis/analyze_reference.py --force');
  }
  if (textHash && a.textHash !== textHash) {
    throw new AnalysisMismatchError('text-hash', 'ملف التحليل لا يطابق نص القصيدة الحالي. أعد توليده بالأمر: python3 analysis/analyze_reference.py --force');
  }
  return true;
}

/** نظرة مصفوفية على الإطارات المرجعية (null → NaN داخليًا، لا يُكتب NaN في أي JSON). */
export class ReferenceData {
  constructor(a) {
    this.a = a;
    this.hop = a.hopSec;
    this.n = a.frames.count;
    this.timeOrigin = a.timeOrigin;
    const c = a.frames.columns;
    this.f0 = Float32Array.from(c.f0Hz, (v) => (v == null ? NaN : v));
    this.voiced = Uint8Array.from(c.voiced);
    this.valid = Uint8Array.from(c.valid);
    this.quality = Float32Array.from(c.pitchQuality, (v) => (v == null ? NaN : v));
    this.energyDb = Float32Array.from(c.energyDb);
    this.reason = Uint8Array.from(c.invalidReason);
    this.cents = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) this.cents[i] = Number.isFinite(this.f0[i]) ? 1200 * Math.log2(this.f0[i] / 100) : NaN;
    const ev = a.segments.events;
    this.pauses = ev.filter((e) => e.type === 'pause');
    this.sustains = ev.filter((e) => e.type === 'sustain');
    this.onsets = ev.filter((e) => e.type === 'onset');
    this.performance = a.segments.regions.find((r) => r.type === 'performance');
    this.stats = a.stats;
  }
  /** فهرس الإطار الأقرب لزمن مرجعي (بالثواني على محور المشغّل). */
  idx(tSec) { return Math.round((tSec - this.timeOrigin) / this.hop); }
  time(i) { return i * this.hop + this.timeOrigin; }
  usablePitch(i) { return this.voiced[i] === 1 && this.valid[i] === 1 && Number.isFinite(this.f0[i]); }
  inPerformance(i) { return this.valid[i] === 1 || this.reason[i] !== 2; }
}

// ───────── توقيتات الأشطار الفعلية مع التصحيح اليدوي ─────────
export const OVERRIDE_VERSION = 1;
export const overridesKey = (a) => `karaoke-overrides:${a.audioHash.slice(0, 16)}:${a.textHash.slice(0, 16)}`;

export function loadOverrides(a, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(overridesKey(a));
    if (!raw) return { version: OVERRIDE_VERSION, audioHash: a.audioHash, textHash: a.textHash, hemistichs: {} };
    const o = JSON.parse(raw);
    if (o.audioHash !== a.audioHash || o.textHash !== a.textHash) throw new Error('hash');
    return o;
  } catch { return { version: OVERRIDE_VERSION, audioHash: a.audioHash, textHash: a.textHash, hemistichs: {} }; }
}
export function saveOverrides(a, o, storage = globalThis.localStorage) {
  try { storage?.setItem(overridesKey(a), JSON.stringify(o)); return true; } catch { return false; }
}

/** قائمة الأشطار الفعلية (142) بعد تطبيق التصحيحات: {id,index,verseIndex,text,startSec,endSec,status,confidence,source}. */
export function effectiveHemistichs(a, overrides) {
  const out = [];
  for (const v of a.verses) {
    for (const h of v.hemistichs) {
      const o = overrides?.hemistichs?.[h.id];
      const manual = o && Number.isFinite(o.startSec) && Number.isFinite(o.endSec) && o.endSec > o.startSec;
      out.push({
        id: h.id, index: h.index, verseIndex: v.index, indexInVerse: h.indexInVerse, text: h.text,
        startSec: manual ? o.startSec : h.startSec, endSec: manual ? o.endSec : h.endSec,
        status: manual ? 'manual' : h.status, confidence: manual ? 1 : h.alignmentConfidence,
        source: manual ? 'manual' : h.timingSource, autoStartSec: h.startSec, autoEndSec: h.endSec,
      });
    }
  }
  return out;
}

/** تصدير/استيراد التوقيتات (ميزة قديمة محفوظة). */
export function exportTimings(a, overrides) {
  return JSON.stringify({
    format: 'karaoke-timings', version: OVERRIDE_VERSION, audioHash: a.audioHash, textHash: a.textHash,
    hemistichs: effectiveHemistichs(a, overrides).map((h) => ({ id: h.id, startSec: h.startSec, endSec: h.endSec, status: h.status })),
  }, null, 1);
}
export function importTimings(a, jsonText) {
  const d = JSON.parse(jsonText);
  if (d.format !== 'karaoke-timings') throw new Error('الملف ليس تصدير توقيتات من هذا التطبيق');
  if (d.audioHash !== a.audioHash || d.textHash !== a.textHash) throw new Error('هذه التوقيتات لتسجيل/نص مختلف (البصمة لا تطابق)');
  const o = { version: OVERRIDE_VERSION, audioHash: a.audioHash, textHash: a.textHash, hemistichs: {} };
  for (const h of d.hemistichs) {
    if (!(Number.isFinite(h.startSec) && Number.isFinite(h.endSec) && h.endSec > h.startSec)) throw new Error(`توقيت غير صالح للشطر ${h.id}`);
    if (h.status === 'manual') o.hemistichs[h.id] = { startSec: h.startSec, endSec: h.endSec, status: 'manual' };
  }
  return o;
}
