// أدوات DOM صغيرة: h()، أيقونات SVG، تنبيه مؤقت، وتفضيلات محفوظة (try/catch لأن التخزين قد يفشل).
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

const P = {
  play: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z',
  pause: 'M7 5h3.2v14H7zM13.8 5H17v14h-3.2z',
  restart: 'M12 5a7 7 0 1 1-6.9 8.2h2.1A5 5 0 1 0 12 7v3L7 6l5-4v3Z',
  prev: 'M7 5h2v14H7zM20 5.5v13a1 1 0 0 1-1.6.8L9.5 13a1 1 0 0 1 0-1.6l8.9-6.7A1 1 0 0 1 20 5.5Z',
  next: 'M15 5h2v14h-2zM4 5.5v13a1 1 0 0 0 1.6.8L14.5 13a1 1 0 0 0 0-1.6L5.6 4.7A1 1 0 0 0 4 5.5Z',
  repeat: 'M17 2l4 4-4 4V7H6a2 2 0 0 0-2 2v2H2V9a4 4 0 0 1 4-4h11V2Zm-10 20-4-4 4-4v3h11a2 2 0 0 0 2-2v-2h2v2a4 4 0 0 1-4 4H7v3Z',
  mic: 'M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2Z',
  headphones: 'M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h1a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H5v-1a7 7 0 0 1 14 0v1h-3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9Z',
  speaker: 'M5 9v6h4l5 4V5L9 9H5Zm11.5 3a4.5 4.5 0 0 0-2-3.7v7.4a4.5 4.5 0 0 0 2-3.7Z',
  gear: 'M19.4 13a7.7 7.7 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1L15 3.4h-4l-.4 2.6a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.7 7.7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z',
  back: 'M10 6l-6 6 6 6 1.4-1.4L7.8 13H20v-2H7.8l3.6-3.6L10 6Z',
  search: 'M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5Zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z',
  edit: 'M3 17.3V21h3.7L17.8 9.9l-3.7-3.7L3 17.3ZM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7L20.7 7Z',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-6h2v6Zm0-8h-2V7h2v2Z',
  ear: 'M12 2a7 7 0 0 0-7 7h2a5 5 0 0 1 10 0c0 2-1 3-2.3 4.2C13.4 14.4 12 15.7 12 18a2 2 0 0 1-4 0H6a4 4 0 0 0 8 0c0-1.2.8-1.9 1.9-3C17.3 13.8 19 12.3 19 9a7 7 0 0 0-7-7Z',
  list: 'M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z',
  video: 'M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4Z',
};
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('fill', 'currentColor');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', P[name] || P.info); s.append(p);
  return s;
}

let toastTimer = null;
export function toast(msg, ms = 4200) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const PREFS_KEY = 'karaoke-prefs-v1';
export const DEFAULT_PREFS = Object.freeze({
  theme: 'auto', motion: 'auto', contrast: 'normal', size: 'normal', digits: 'arabic',
  timeDir: 'rtl',            // rtl: المستقبل إلى اليسار (يوافق اتجاه قراءة الشعر) — ltr: المستقبل إلى اليمين
  mode: 'strict', headphones: true, listenVolume: 0.8, manualMs: 0, countdown: 3, repeat: false, lastIndex: 0, sttConsent: false, sttOn: true,
});
export function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); return true; } catch { return false; } }
export function applyPrefs(p) {
  const r = document.documentElement;
  const set = (k, v, dflt) => (v === dflt ? r.removeAttribute(k) : r.setAttribute(k, v));
  set('data-theme', p.theme, 'auto'); set('data-motion', p.motion, 'auto'); set('data-contrast', p.contrast, 'normal'); set('data-size', p.size, 'normal');
}
export const prefersReducedMotion = () => document.documentElement.getAttribute('data-motion') === 'reduce'
  || (document.documentElement.getAttribute('data-motion') !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches);
