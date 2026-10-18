'use strict';
// Regression: the pinned lookup behind publicDispatcher must satisfy BOTH DNS
// consumers. Node's http.get (nodeHttpFetch, used for sub-agent GETs) asks for a
// single address and reads (error, address, family); undici's connect asks for
// the whole list ({ all: true }) and reads addresses[0]. Returning a bare string
// for the undici call made addresses[0] the first character and every
// main-context web read failed with ERR_INVALID_IP_ADDRESS.
//
// Run with: node --test tests/webSearchDispatcher.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const { publicDispatcher, pinnedLookup } = require('../src/main/tools/webSearch');

function lookupOnce(lookup, options) {
  return new Promise((resolve, reject) => {
    lookup('example.com', options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

test('pinned lookup answers undici (all: true) with an address list and Node http with a single address', async () => {
  const lookup = pinnedLookup('93.184.216.34', 4);
  // undici's connector contract: an array of { address, family }.
  assert.deepEqual((await lookupOnce(lookup, { all: true })).address, [{ address: '93.184.216.34', family: 4 }]);
  // Node's http.get contract: (address, family).
  assert.deepEqual(await lookupOnce(lookup, { family: 4 }), { address: '93.184.216.34', family: 4 });
  assert.deepEqual(await lookupOnce(lookup, undefined), { address: '93.184.216.34', family: 4 });
});

test('publicDispatcher pins a validated address for both lookup shapes', async () => {
  const dispatcher = await publicDispatcher(new URL('https://example.com/page'), {
    resolve: async (hostname, options) => {
      assert.equal(hostname, 'example.com');
      assert.deepEqual(options, { all: true });
      return [{ address: '93.184.216.34', family: 4 }];
    },
  });
  try {
    assert.equal(typeof dispatcher.nodeLookup, 'function');
    assert.deepEqual((await lookupOnce(dispatcher.nodeLookup, { all: true })).address, [{ address: '93.184.216.34', family: 4 }]);
    assert.deepEqual(await lookupOnce(dispatcher.nodeLookup, { family: 4 }), { address: '93.184.216.34', family: 4 });
  } finally {
    await dispatcher.close();
  }
});

test('publicDispatcher prefers IPv4 so the family-4 Node transport never mismatches', async () => {
  const dispatcher = await publicDispatcher(new URL('https://example.com'), {
    resolve: async () => [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }, { address: '93.184.216.34', family: 4 }],
  });
  try {
    assert.deepEqual(await lookupOnce(dispatcher.nodeLookup, { family: 4 }), { address: '93.184.216.34', family: 4 });
  } finally {
    await dispatcher.close();
  }
});

test('publicDispatcher rejects hosts whose resolved addresses are not all public', async () => {
  await assert.rejects(
    publicDispatcher(new URL('https://rebind.example'), { resolve: async () => [{ address: '127.0.0.1', family: 4 }] }),
    /does not resolve to a public address/,
  );
  await assert.rejects(
    publicDispatcher(new URL('https://empty.example'), { resolve: async () => [] }),
    /does not resolve to a public address/,
  );
});
