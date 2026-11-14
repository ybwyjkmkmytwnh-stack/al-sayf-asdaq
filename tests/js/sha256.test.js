import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { sha256HexSync } from '../../web/js/core/sha256.js';
import { sha256Hex, poemTextHash } from '../../web/js/core/analysis.js';

const nodeHash = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('SHA-256: متجهات معروفة', () => {
  assert.equal(sha256HexSync(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256HexSync(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const long = new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq');
  assert.equal(sha256HexSync(long), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('SHA-256: أطوال حدّية (55/56/63/64/65 بايت) تطابق node', () => {
  for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 65537]) {
    const b = crypto.randomBytes(n);
    assert.equal(sha256HexSync(new Uint8Array(b)), nodeHash(b), `n=${n}`);
  }
});

test('SHA-256: ملف التسجيل الفعلي يطابق بصمة ملف التحليل (مسار JS الاحتياطي)', () => {
  const mp3 = fs.readFileSync('web/audio/reference.mp3');
  const a = JSON.parse(fs.readFileSync('web/data/reference_analysis.json', 'utf8'));
  assert.equal(sha256HexSync(new Uint8Array(mp3)), a.audioHash);
});

test('بصمة النص تُحسب في المتصفح بنفس طريقة بايثون', async () => {
  const poem = JSON.parse(fs.readFileSync('web/data/poem.json', 'utf8'));
  assert.equal(await poemTextHash(poem.lines), poem.textHash);
});

test('sha256Hex يعمل بلا crypto.subtle (صفحة غير آمنة)', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    const b = new TextEncoder().encode('abc');
    assert.equal(await sha256Hex(b), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'crypto', saved); else delete globalThis.crypto;
  }
});
