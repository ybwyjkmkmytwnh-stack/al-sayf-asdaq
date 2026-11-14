import test from 'node:test';
import assert from 'node:assert/strict';
import { Cloud, summarizeAttempts } from '../../web/js/cloud/client.js';
// خادم وهمي يحاكي GoTrue/PostgREST وقيد unique(user_id, client_attempt_id)
function mock({ failInsert = 0, expire = false } = {}) {
  const db = { attempts: [], calls: [] }; let fails = failInsert, tokenOk = !expire;
  const f = async (url, opt) => {
    const u = new URL(url), p = u.pathname; db.calls.push(`${opt.method} ${p}`);
    const j = (o, s = 200) => ({ ok: s < 300, status: s, json: async () => o, text: async () => JSON.stringify(o) });
    if (p === '/auth/v1/token') { tokenOk = true; return j({ access_token: 'a2', refresh_token: 'r', user: { id: 'U1', email: 'a@b.c' } }); }
    if (p === '/rest/v1/attempts' && opt.method === 'POST') {
      if (!tokenOk) return j({ message: 'jwt expired' }, 401);
      if (fails > 0) { fails--; throw new TypeError('network'); }
      const b = JSON.parse(opt.body); if (!db.attempts.some((x) => x.user_id === b.user_id && x.client_attempt_id === b.client_attempt_id)) db.attempts.push(b);
      return { ok: true, status: 201, text: async () => '' };
    }
    return j({}, 404);
  };
  return { db, f };
}
const mk = (m) => { const c = new Cloud({ url: 'https://x.supabase.co', anonKey: 'k', store: new Map(), fetchImpl: m.f }); c.session = { access_token: 'a', refresh_token: 'r', user: { id: 'U1' } }; return c; };
test('guest never calls server', async () => { const m = mock(); const c = new Cloud({ url: 'https://x', anonKey: 'k', store: new Map(), fetchImpl: m.f }); assert.equal((await c.saveAttempt({ poem_id: 'p', hem_id: 'h' })).status, 'guest'); assert.equal(m.db.calls.length, 0); });
test('network failure queues, retry saves once (no duplicates)', async () => {
  const m = mock({ failInsert: 1 }); const c = mk(m);
  const r = await c.saveAttempt({ client_attempt_id: 'c1', poem_id: 'p', hem_id: 'h' }); assert.equal(r.status, 'queued'); assert.equal(c.pending.length, 1);
  assert.deepEqual(await c.flush(), { sent: 1, left: 0 }); await c.saveAttempt({ client_attempt_id: 'c1', poem_id: 'p', hem_id: 'h' }); assert.equal(m.db.attempts.length, 1);
});
test('expired token refreshes and retries', async () => { const m = mock({ expire: true }); const c = mk(m); const r = await c.saveAttempt({ client_attempt_id: 'c2', poem_id: 'p', hem_id: 'h' }); assert.equal(r.status, 'saved'); assert.equal(m.db.attempts.length, 1); });
test('summary: unmeasurable attempts do not enter word errors', () => {
  const rows = [{ hem_id: 'h1', hem_index: 0, measurable: true, words_json: [{ status: 'substitute', expected: 'إِنْبَاءً', expectedNorm: 'انبا' }] }, { hem_id: 'h1', hem_index: 0, measurable: false, words_json: [{ status: 'missing', expected: 'x', expectedNorm: 'x' }] }];
  const s = summarizeAttempts(rows); assert.equal(s.hems[0].attempts, 2); assert.equal(s.wordsToReview.length, 1);
});
