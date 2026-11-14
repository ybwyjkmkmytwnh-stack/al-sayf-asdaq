import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => JSON.parse(readFileSync(new URL(`../../web/data/${p}`, import.meta.url), 'utf8'));
const poem = read('poem.json'), pros = read('prosody.json');

test('prosody: 71 verses, all matched to al-Basit feet, flagged unverified', () => {
  assert.equal(pros.meter, 'البسيط');
  assert.equal(pros.verified, false);
  assert.equal(pros.verses.length, poem.lines.length / 2);
  assert.deepEqual(pros.unmatchedVerses, []);
  for (const v of pros.verses) { assert.equal(v.feet.length, 8); assert.equal(v.bits.length, v.feet.reduce((a, f) => a + f.pattern.length, 0)); }
});

test('prosody: words equal the poem lines (no text drift)', () => {
  pros.verses.forEach((v, i) => {
    const h1 = v.words.slice(0, v.n1).map((w) => w.text).join(' '), h2 = v.words.slice(v.n1).map((w) => w.text).join(' ');
    assert.equal(h1, poem.lines[2 * i]); assert.equal(h2, poem.lines[2 * i + 1]);
  });
});
