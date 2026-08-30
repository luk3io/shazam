const test = require('node:test');
const assert = require('node:assert');
const { fingerprint } = require('../src/dsp.js');

const peaks = [{ t: 0, f: 10, mag: 1 }, { t: 3, f: 20, mag: 1 }, { t: 5, f: 15, mag: 1 }];

test('fingerprint is deterministic and produces valid uint32 hashes', () => {
  const a = fingerprint(peaks), b = fingerprint(peaks);
  assert.deepStrictEqual(a, b);
  assert.ok(a.length > 0);
  assert.ok(a.every(fp => Number.isInteger(fp.hash) && fp.hash >= 0 && fp.hash <= 0xFFFFFFFF));
});
