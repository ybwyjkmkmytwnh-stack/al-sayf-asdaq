import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReferenceData } from '../../web/js/core/analysis.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
let _a = null, _ref = null;
export function loadAnalysis() {
  if (!_a) _a = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/reference_analysis.json'), 'utf8'));
  return _a;
}
export function loadRef() {
  if (!_ref) _ref = new ReferenceData(loadAnalysis());
  return _ref;
}

/** مستخدم «مثالي» مبنيّ من إطارات المرجع نفسها مع تعديلات معروفة. t بزمن مرجعي بعد التعويض. */
export function userFromRef(ref, { t0, t1, tStart, tEnd, delaySec = 0, centsShift = 0, dbShift = 0, mutate = null, measurable = 1 } = {}) {
  const i0 = ref.idx(t0 ?? tStart), i1 = ref.idx(t1 ?? tEnd);
  const n = i1 - i0;
  const u = { t: new Float64Array(n), f0: new Float32Array(n).fill(NaN), periodicity: new Float32Array(n), energyDb: new Float32Array(n),
    voiced: new Uint8Array(n), measurable: new Uint8Array(n).fill(measurable) };
  const k = 2 ** (centsShift / 1200);
  for (let j = 0; j < n; j++) {
    const i = i0 + j;
    u.t[j] = ref.time(i) + delaySec;
    const v = ref.voiced[i] && ref.valid[i] && Number.isFinite(ref.f0[i]);
    u.voiced[j] = v ? 1 : 0;
    u.f0[j] = v ? ref.f0[i] * k : NaN;
    u.periodicity[j] = v ? (Number.isFinite(ref.quality[i]) ? Math.max(ref.quality[i], 0.8) : 0.9) : 0.1;
    u.energyDb[j] = ref.energyDb[i] + dbShift;
  }
  if (mutate) mutate(u, ref, i0);
  return u;
}
export const CAL = { noiseFloorDb: -70, comfortLevelDb: -8.7 }; // comfortLevel = وسيط قوة المرجع المجهورة
export const W = { tStart: 22.4, tEnd: 40.6 }; // بيتان كاملان تقريبًا (v03–v04)
