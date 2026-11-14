import test from 'node:test';
import assert from 'node:assert/strict';
import { compareWords, countsAsRead, describeDiff, tokens, normWord } from '../../web/js/core/speech.js';
const HEM = 'السَّيْفُ أَصْدَقُ إِنْبَاءً مِنَ الْكُتُبِ';
test('normalize', () => { assert.equal(normWord('إِنْبَاءً'), 'انبا'); assert.deepEqual(tokens('السَّيْفُ، أصدقُ'), ['السيف', 'اصدق']); });
test('exact without diacritics', () => { const c = compareWords(HEM, 'السيف اصدق انباء من الكتب'); assert.equal(c.verdict, 'exact'); assert.ok(countsAsRead(c)); });
test('substituted word confirmed when final', () => {
  const c = compareWords(HEM, 'السيف أصدق قولا من الكتب', { final: true, confidence: 0.9 });
  assert.equal(c.items.find((x) => x.status === 'substitute').heard, 'قولا'); assert.ok(!countsAsRead(c)); assert.match(describeDiff(c), /قولا.*إِنْبَاءً/);
});
test('interim result never confirms a difference', () => {
  const c = compareWords(HEM, 'السيف أصدق قولا', { final: false });
  assert.ok(!c.items.some((x) => x.status === 'substitute' || x.status === 'missing')); assert.ok(!countsAsRead(c));
});
test('low confidence is ambiguous', () => { const c = compareWords(HEM, 'السيف اصدق قولا من الكتب', { final: true, confidence: 0.2 }); assert.ok(c.items.some((x) => x.status === 'ambiguous')); assert.ok(!c.items.some((x) => x.status === 'substitute')); });
test('empty heard', () => { const c = compareWords(HEM, ''); assert.equal(c.verdict, 'none'); assert.ok(!countsAsRead(c)); });
test('humming/unrelated is not read', () => { const c = compareWords(HEM, 'لا لا لا'); assert.ok(!countsAsRead(c)); });
test('missing word', () => { const c = compareWords(HEM, 'السيف اصدق من الكتب'); assert.equal(c.items.find((x) => x.expectedNorm === 'انبا').status, 'missing'); });
test('does not prefer poem text for mishearing', () => { const c = compareWords(HEM, 'السيف اصدق ابناء من الكتب'); assert.ok(c.items.every((x) => x.status !== 'match' || x.sim >= 0.8)); });
