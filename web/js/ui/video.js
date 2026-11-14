// ميزة توليد الفيديو (محفوظة من التطبيق الأصلي): خادم محلي اختياري. فشله لا يؤثر على التدريب أبدًا.
// الخادم محلي (127.0.0.1) لا خدمة خارجية، ولا يُرسل شيء إلا عند ضغط «إنشاء الفيديو».
// ما يُرسَل هو ملف التسجيل المرجعي المرفق (وصورة اختيارية) — ولا يُرسَل أي صوت من المستخدم (التطبيق لا يسجّل صوته أصلًا).
import { h, icon } from './dom.js';
import { describeVideoServerError } from '../audio/errors.js';

export const VIDEO_BASE = 'http://127.0.0.1:5000';
export const VIDEO_ENDPOINT = `${VIDEO_BASE}/generate-poem-video`;
export const VIDEO_HEALTH = `${VIDEO_BASE}/health`;

async function fetchWithTimeout(url, opts = {}, ms = 3000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

export async function checkVideoServer() {
  try {
    const r = await fetchWithTimeout(VIDEO_HEALTH, {}, 2500);
    return { ok: r.ok, status: r.status };
  } catch (err) { return { ok: false, error: describeVideoServerError(err) }; }
}

export async function generateVideo({ audioUrl, image = null, onStatus }) {
  try {
    onStatus?.('جارٍ تجهيز الملف…');
    const audioBlob = await (await fetch(audioUrl)).blob();
    const fd = new FormData();
    fd.append('audio', audioBlob, 'reference.mp3');
    if (image) fd.append('image', image, image.name);
    onStatus?.('جارٍ إنشاء الفيديو على الخادم المحلي (قد يستغرق دقائق)…');
    const r = await fetchWithTimeout(VIDEO_ENDPOINT, { method: 'POST', body: fd }, 15 * 60 * 1000);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) return { ok: false, error: data.error || `رفض الخادم الطلب (HTTP ${r.status}).` };
    if (!data.video_url) return { ok: false, error: 'استجاب الخادم دون رابط فيديو.' };
    return { ok: true, url: data.video_url.startsWith('http') ? data.video_url : VIDEO_BASE + data.video_url };
  } catch (err) { return { ok: false, error: describeVideoServerError(err) }; }
}

export function videoCard({ audioUrl }) {
  const status = h('p', { class: 'small muted' }, 'اختياري: يتطلب تشغيل خادم الفيديو المحلي على المنفذ ٥٠٠٠. غيابه لا يؤثر على التدريب.');
  const out = h('div');
  const file = h('input', { type: 'file', accept: 'image/*' });
  const btnCheck = h('button', { class: 'btn', onclick: async () => {
    status.textContent = 'جارٍ الفحص…';
    const r = await checkVideoServer();
    status.textContent = r.ok ? 'الخادم المحلي يعمل ✓' : (r.error || 'الخادم لا يستجيب.');
  } }, 'فحص الخادم');
  const btnGen = h('button', { class: 'btn primary', onclick: async () => {
    btnGen.disabled = true; out.replaceChildren();
    const r = await generateVideo({ audioUrl, image: file.files?.[0] || null, onStatus: (s) => { status.textContent = s; } });
    btnGen.disabled = false;
    if (r.ok) { status.textContent = 'اكتمل الفيديو.'; out.replaceChildren(h('a', { class: 'btn', href: r.url, target: '_blank', rel: 'noopener' }, 'فتح الفيديو')); }
    else status.textContent = r.error;
  } }, icon('video'), 'إنشاء الفيديو');
  return h('div', { class: 'card flat col' },
    h('h3', null, 'إنشاء فيديو للقصيدة (اختياري)'), status,
    h('div', { class: 'field' }, h('label', null, 'صورة خلفية (اختيارية)'), file),
    h('div', { class: 'row' }, btnCheck, btnGen), out);
}
