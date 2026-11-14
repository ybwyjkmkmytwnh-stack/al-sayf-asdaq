// أدوات نص عربي وتنسيق أرقام/أزمنة للواجهة (تطابق normalize_ar في analysis/refkit/poem.py).
const TASHKEEL = /[ً-ٰٟـ]/g;
const ALEF = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ة': 'ه' };

/** تطبيع للبحث/المطابقة: حذف التشكيل والتطويل، توحيد الألف والياء/الألف المقصورة والتاء المربوطة. */
export function normalizeAr(text) {
  return String(text).replace(TASHKEEL, '').replace(/[أإآٱىة]/g, (c) => ALEF[c]);
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
/** يحوّل الأرقام اللاتينية إلى هندية (ما لم يُطلب غير ذلك). */
export function arDigits(s, western = false) {
  return western ? String(s) : String(s).replace(/[0-9]/g, (d) => AR_DIGITS[d]);
}
export function fmtTime(sec, western = false) {
  if (!Number.isFinite(sec)) return '—';
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60), r = s - m * 60;
  return arDigits(`${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`, western);
}
export function fmtNum(x, d = 0, western = false) {
  if (!Number.isFinite(x)) return '—';
  return arDigits(x.toFixed(d).replace('-', '−'), western);
}
export function fmtPct(x, western = false) { return Number.isFinite(x) ? arDigits(`${Math.round(x * 100)}٪`, western) : '—'; }
