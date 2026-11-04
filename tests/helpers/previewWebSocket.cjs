'use strict';
// Minimal controlled RFC6455 fixture. Browser/Vite acceptance separately uses
// Chromium's real WebSocket implementation, not this fixture parser.
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { randomBytes, createHash } = require('node:crypto');
function server(server) {
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length < 6) return;
      const length = buffer[1] & 127;
      if (length > 125) return socket.destroy();
      if (buffer.length < 6 + length) return;
      const payload = Buffer.from(buffer.subarray(6, 6 + length));
      for (let i = 0; i < length; i++) payload[i] ^= buffer[2 + i % 4];
      socket.write(Buffer.concat([Buffer.from([0x81, length]), payload])); buffer = buffer.subarray(6 + length);
    }); socket.on('error', () => {});
  });
}
function connect(url, { origin, headers = {} }) {
  return new Promise((resolve, reject) => {
    const address = new URL(url), socket = net.connect(Number(address.port), address.hostname);
    const ws = new EventEmitter(); ws.readyState = 0; ws.terminate = () => socket.destroy();
    ws.send = text => { const data = Buffer.from(text), mask = randomBytes(4), payload = Buffer.from(data); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), mask, payload])); };
    socket.on('connect', () => {
      const h = { Host: address.host, Origin: origin, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...headers };
      socket.write(`GET ${address.pathname || '/'} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
    });
    let buffer = Buffer.alloc(0), upgraded = false;
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
        if (!buffer.subarray(0, end).toString().startsWith('HTTP/1.1 101')) { socket.destroy(); reject(new Error('HTTP 403')); return; }
        buffer = buffer.subarray(end + 4); upgraded = true; ws.readyState = 1; resolve(ws);
      }
      while (buffer.length >= 2 && buffer.length >= 2 + (buffer[1] & 127)) {
        const length = buffer[1] & 127; ws.emit('message', buffer.subarray(2, 2 + length)); buffer = buffer.subarray(2 + length);
      }
    }); socket.on('error', reject); socket.on('close', () => { ws.readyState = 3; ws.emit('close'); });
  });
}
module.exports = { server, connect };
