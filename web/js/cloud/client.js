// عميل Supabase خفيف بلا اعتماديات (GoTrue + PostgREST عبر fetch). يعمل بمفتاح النشر العلني فقط؛ الحماية الفعلية في سياسات RLS داخل قاعدة البيانات.
// لا أسرار هنا. الحفظ idempotent عبر client_attempt_id، مع طابور محلي عند فشل الشبكة.
export class CloudError extends Error { constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; } }
const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
export { uuid };

export class Cloud extends EventTarget {
  constructor({ url = '', anonKey = '', store = null, fetchImpl = null, appVersion = 'dev' } = {}) {
    super();
    this.url = String(url || '').replace(/\/+$/, ''); this.anonKey = anonKey || '';
    this.store = store || (typeof localStorage !== 'undefined' ? localStorage : new Map());
    this.f = fetchImpl || ((...a) => fetch(...a)); this.appVersion = appVersion;
    this.session = this._read('kp.session'); this.pending = this._read('kp.pending') || [];
  }
  get configured() { return !!(this.url && this.anonKey); }
  get user() { return this.session?.user || null; }
  _read(k) { try { const v = this.store.getItem ? this.store.getItem(k) : this.store.get(k); return v ? JSON.parse(v) : null; } catch { return null; } }
  _write(k, v) { try { const s = JSON.stringify(v); this.store.setItem ? (v == null ? this.store.removeItem(k) : this.store.setItem(k, s)) : this.store.set(k, s); } catch { /* */ } }
  _emit(t, d) { this.dispatchEvent(new CustomEvent(t, { detail: d })); }
  _setSession(s) { this.session = s; this._write('kp.session', s); this._emit('auth', { user: this.user }); }

  async _http(path, { method = 'GET', body, headers = {}, auth = true, retry = true } = {}) {
    if (!this.configured) throw new CloudError('not-configured', 'الحفظ السحابي غير مُعدّ.');
    const h = { apikey: this.anonKey, 'Content-Type': 'application/json', ...headers };
    if (auth && this.session?.access_token) h.Authorization = `Bearer ${this.session.access_token}`; else h.Authorization = `Bearer ${this.anonKey}`;
    let res;
    try { res = await this.f(this.url + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) }); }
    catch { throw new CloudError('network', 'تعذّر الاتصال بالخادم.'); }
    if (res.status === 401 && auth && retry && this.session?.refresh_token) { await this.refresh(); return this._http(path, { method, body, headers, auth, retry: false }); }
    if (!res.ok) {
      let j = null; try { j = await res.json(); } catch { /* */ }
      const msg = j?.msg || j?.message || j?.error_description || `HTTP ${res.status}`;
      throw new CloudError(res.status === 401 || res.status === 403 ? 'auth' : res.status === 409 ? 'conflict' : 'server', msg, res.status);
    }
    if (res.status === 204) return null;
    const t = await res.text(); return t ? JSON.parse(t) : null;
  }
  async signUp(email, password) {
    const j = await this._http('/auth/v1/signup', { method: 'POST', body: { email, password }, auth: false });
    if (j?.access_token) this._setSession(j); return { needsConfirm: !j?.access_token };
  }
  async signIn(email, password) { this._setSession(await this._http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, auth: false })); await this.flush(); }
  async refresh() {
    try { this._setSession(await this._http('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: this.session.refresh_token }, auth: false })); }
    catch (e) { this._setSession(null); this._emit('expired', {}); throw new CloudError('expired', 'انتهت الجلسة — سجّل الدخول مجددًا.'); }
  }
  async signOut() { try { if (this.session) await this._http('/auth/v1/logout', { method: 'POST', retry: false }); } catch { /* */ } this._setSession(null); }

  /** يحفظ محاولة مرة واحدة: client_attempt_id يمنع التكرار. يعيد 'saved' أو 'queued' (لم تُحفظ بعد). */
  async saveAttempt(rec) {
    const row = { client_attempt_id: rec.client_attempt_id || uuid(), app_version: this.appVersion, ...rec };
    if (!this.user) return { status: 'guest', id: row.client_attempt_id };
    try { await this._insert(row); return { status: 'saved', id: row.client_attempt_id }; }
    catch (e) {
      if (e.kind === 'network' || e.kind === 'server') { this._enqueue(row); return { status: 'queued', id: row.client_attempt_id, error: e.message }; }
      throw e;
    }
  }
  _insert(row) {
    return this._http('/rest/v1/attempts?on_conflict=user_id,client_attempt_id', { method: 'POST', body: { ...row, user_id: this.user.id }, headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
  }
  _enqueue(row) { if (!this.pending.some((p) => p.client_attempt_id === row.client_attempt_id)) { this.pending.push(row); this._write('kp.pending', this.pending); } }
  async flush() {
    if (!this.user) return { sent: 0, left: this.pending.length };
    let sent = 0;
    for (const row of [...this.pending]) {
      try { await this._insert(row); this.pending = this.pending.filter((p) => p !== row); sent++; } catch (e) { if (e.kind !== 'conflict') break; this.pending = this.pending.filter((p) => p !== row); }
    }
    this._write('kp.pending', this.pending); return { sent, left: this.pending.length };
  }
  async listAttempts({ limit = 200 } = {}) { return this._http(`/rest/v1/attempts?select=*&order=created_at.desc&limit=${limit}`); }
  async sendReport(rep) { return this._http('/rest/v1/reports?on_conflict=user_id,client_report_id', { method: 'POST', body: { ...rep, user_id: this.user.id, app_version: this.appVersion }, headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } }); }
}

/** يلخّص المحاولات لصفحة «تدريباتي»: آخر موضع، عدد المحاولات لكل شطر، والكلمات التي احتاجت إعادة (قابلة للقياس فقط). */
export function summarizeAttempts(rows) {
  const byHem = new Map(), words = new Map();
  for (const r of rows) {
    const k = r.hem_id; const e = byHem.get(k) || { hem_id: k, hem_index: r.hem_index, poem_id: r.poem_id, attempts: 0, last: r };
    e.attempts++; byHem.set(k, e);
    if (!r.measurable || !Array.isArray(r.words_json)) continue;     // محاولة بلا قياس كافٍ لا تُضاف لأخطائي
    for (const w of r.words_json) if (w.status === 'substitute' || w.status === 'missing') { const wk = `${k}|${w.expectedNorm}`; const x = words.get(wk) || { hem_id: k, word: w.expected, n: 0 }; x.n++; words.set(wk, x); }
  }
  return { lastAttempt: rows[0] || null, hems: [...byHem.values()].sort((a, b) => (a.hem_index ?? 0) - (b.hem_index ?? 0)), wordsToReview: [...words.values()].sort((a, b) => b.n - a.n) };
}
