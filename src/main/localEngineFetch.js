'use strict';

const { Agent, fetch } = require('undici');

// Large multimodal prefills can be silent for minutes, both before headers and
// between SSE chunks. Disable response deadlines only for local inference.
// Connection establishment still has its normal timeout; caller aborts work.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const { createContextGuardedFetch } = require('./contextBudget');
const { createMediaGuardedFetch } = require('./modelCapabilities');
const rawFetch = (url, options) => fetch(url, { ...options, dispatcher });
const localEngineFetch = createContextGuardedFetch(createMediaGuardedFetch(rawFetch));

module.exports = { localEngineFetch };
