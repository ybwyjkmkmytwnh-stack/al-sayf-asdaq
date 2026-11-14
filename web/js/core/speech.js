// مقارنة ما قاله المستخدم (نص محرّك التعرّف) بنص الشطر المتوقّع — بلا تشكيل ولا ترقيم.
// لا يعرف هذا الملف القصيدة؛ المقارنة تتم بعد صدور النص فقط، ولا يُمرَّر أي نص متوقَّع إلى المحرّك.
const MARKS = /[ً-ٰٟـۖ-ۭ]/g;
const PUNCT = /[^ء-ي٠-٩a-zA-Z0-9\s]/g;
const MAP = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي', 'ء': '' };

export function normWord(w) {
  return String(w).replace(MARKS, '').replace(/[أإآٱىةؤئء]/g, (c) => MAP[c]).replace(PUNCT, '');
}
export function tokens(text) {
  return String(text || '').replace(MARKS, '').split(/[\s،,.؛;:!؟?"'«»()\-–—…]+/).map(normWord).filter(Boolean);
}
export function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
export function sim(a, b) { const L = Math.max(a.length, b.length); return L ? 1 - lev(a, b) / L : 1; }
export const T_MATCH = 0.8, T_AMBIG = 0.5;

/**
 * يقارن الكلمات المتوقّعة (displayWords بتشكيلها للعرض) بنص التعرّف.
 * final: هل النتيجة نهائية؟ confidence: ثقة المحرّك (0..1) إن وُجدت.
 * الفروق المؤكَّدة (status='substitute'|'missing'|'extra') لا تُصدَر إلا لنتيجة نهائية بثقة كافية؛ وإلا 'ambiguous'.
 */
export function compareWords(expectedText, heardText, { final = true, confidence = null } = {}) {
  const exDisp = String(expectedText).trim().split(/\s+/).filter(Boolean);
  const ex = exDisp.map(normWord);
  const hd = tokens(heardText);
  const heardEmpty = hd.length === 0;
  if (heardEmpty) return { items: exDisp.map((d, i) => ({ expected: d, expectedNorm: ex[i], heard: null, status: 'missing' })), extra: [], matched: 0, total: ex.length, ratio: 0, verdict: 'none', confirmed: final };
  const n = ex.length, m = hd.length, GAP = 1, INF = 1e9;
  const D = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF)); const B = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  D[0][0] = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    if (i < n && D[i][j] + GAP < D[i + 1][j]) { D[i + 1][j] = D[i][j] + GAP; B[i + 1][j] = 1; }
    if (j < m && D[i][j] + GAP < D[i][j + 1]) { D[i][j + 1] = D[i][j] + GAP; B[i][j + 1] = 2; }
    if (i < n && j < m) { const c = D[i][j] + (1 - sim(ex[i], hd[j])) * 1.2; if (c < D[i + 1][j + 1]) { D[i + 1][j + 1] = c; B[i + 1][j + 1] = 3; } }
  }
  const out = []; const extra = []; let i = n, j = m;
  while (i > 0 || j > 0) {
    const b = B[i][j];
    if (b === 3) { out.push({ ei: i - 1, hj: j - 1 }); i--; j--; }
    else if (b === 1) { out.push({ ei: i - 1, hj: null }); i--; }
    else { out.push({ ei: null, hj: j - 1 }); j--; }
  }
  out.reverse();
  const confOk = confidence == null || confidence >= 0.5;
  const sure = final && confOk;
  const items = []; let score = 0;
  for (const o of out) {
    if (o.ei == null) { extra.push({ heard: hd[o.hj], status: sure ? 'extra' : 'ambiguous' }); continue; }
    const e = ex[o.ei], d = exDisp[o.ei];
    if (o.hj == null) { items.push({ expected: d, expectedNorm: e, heard: null, status: sure ? 'missing' : 'ambiguous' }); continue; }
    const s = sim(e, hd[o.hj]);
    let status = s >= T_MATCH ? 'match' : s >= T_AMBIG ? 'ambiguous' : (sure ? 'substitute' : 'ambiguous');
    if (status === 'match') score += 1; else if (status === 'ambiguous') score += 0.5 * s;
    items.push({ expected: d, expectedNorm: e, heard: hd[o.hj], status, sim: +s.toFixed(2) });
  }
  const matched = items.filter((x) => x.status === 'match').length;
  const ratio = score / n;
  const ambiguous = items.some((x) => x.status === 'ambiguous') || !sure;
  const verdict = matched === n && !extra.length ? 'exact' : ratio >= 0.85 && !items.some((x) => x.status === 'substitute') ? (ambiguous ? 'likely' : 'read') : ratio >= 0.5 ? 'partial' : 'different';
  return { items, extra, matched, total: n, ratio: +ratio.toFixed(2), verdict, confirmed: sure };
}

/** هل تُحتسب القراءة «قراءة للبيت»؟ فقط إن طابقت الكلمات (لا يكفي النَّدْب/الدندنة). */
export function countsAsRead(cmp) { return !!cmp && (cmp.verdict === 'exact' || cmp.verdict === 'read'); }

/** وصف عربي موجز للفروق المؤكَّدة. */
export function describeDiff(cmp) {
  if (!cmp) return '';
  if (cmp.verdict === 'none') return 'لم يصلنا كلام مفهوم.';
  const subs = cmp.items.filter((x) => x.status === 'substitute');
  const miss = cmp.items.filter((x) => x.status === 'missing');
  const amb = cmp.items.filter((x) => x.status === 'ambiguous');
  const parts = [];
  for (const s of subs) parts.push(`قلت «${s.heard}» بدل «${s.expected}»`);
  if (miss.length) parts.push(`لم نسمع: ${miss.map((x) => `«${x.expected}»`).join('، ')}`);
  if (cmp.extra.some((x) => x.status === 'extra')) parts.push(`زيادة: ${cmp.extra.filter((x) => x.status === 'extra').map((x) => `«${x.heard}»`).join('، ')}`);
  if (!parts.length && amb.length) return `لسنا متأكدين من ${amb.map((x) => `«${x.expected}»`).join('، ')} — أعد الشطر.`;
  if (!parts.length) return cmp.verdict === 'exact' ? 'الكلمات مطابقة للنص.' : 'الكلمات قريبة من النص.';
  return parts.join(' · ');
}
