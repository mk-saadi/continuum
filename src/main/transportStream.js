'use strict';

const fs = require('node:fs');

// MPEG-TS sync bytes repeat every packet (188 bytes, or 192/204 with framing).
// An extension alone cannot distinguish a transport stream from TypeScript.
function isTransportStreamFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytes = Buffer.alloc(204 * 6);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    for (const stride of [188, 192, 204]) {
      for (let offset = 0; offset < stride; offset++) {
        if (offset + stride * 4 >= length) continue;
        if ([0, 1, 2, 3, 4].every(index => bytes[offset + stride * index] === 0x47)) return true;
      }
    }
    return false;
  } finally { fs.closeSync(fd); }
}

module.exports = { isTransportStreamFile };
