import test from 'node:test';
import assert from 'node:assert/strict';
import { hasMultipleRequests } from '../src/lib/requestAccounting.mjs';
test('aggregate scope does not imply multiple requests (12,213-token hello)', () => {
 assert.equal(hasMultipleRequests({scope:'all',promptRequests:1,promptTokens:12061,completionTokens:152}),false);
 assert.equal(hasMultipleRequests({scope:'all',promptRequests:2}),true);
 assert.equal(hasMultipleRequests({scope:'all',raw:[{},{}]}),true);
 assert.equal(hasMultipleRequests({scope:'all'}),false);
 assert.equal(hasMultipleRequests({scope:'final',promptRequests:3}),false);
});
