'use strict';
// Compatibility source-local launcher.
//
// The earlier W7 implementation used this file to force a dedicated, separate
// application profile. That profile separation is gone: this shim now
// runs the normal application entry, which resolves and reuses the primary
// application profile exactly like `npm run dev`. Use `npm run dev` for the
// supported workflow; this file remains accepted so existing harnesses keep
// working.
require('../main.js');
