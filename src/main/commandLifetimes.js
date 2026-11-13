'use strict';
// Wall-clock lifetimes are separate from how long a tool call waits to return.
module.exports = Object.freeze({ DEFAULT_MS: 60 * 60 * 1000, MAX_MS: 24 * 60 * 60 * 1000, YIELD_MS: 10000 });
