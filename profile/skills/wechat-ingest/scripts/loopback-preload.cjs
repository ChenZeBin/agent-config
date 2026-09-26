'use strict';

// WechatSync CLI 1.1.0 opens its WebSocket and HTTP bridge on every network
// interface. Force only those two listeners onto loopback without modifying the
// globally installed package. This file is loaded through NODE_OPTIONS.
const net = require('node:net');

const originalListen = net.Server.prototype.listen;
const basePort = Number.parseInt(process.env.SYNC_WS_PORT || '9527', 10);
const protectedPorts = new Set([basePort, basePort + 1]);

function numericPort(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

net.Server.prototype.listen = function loopbackOnlyListen(...args) {
  const first = args[0];

  if (first && typeof first === 'object') {
    const port = numericPort(first.port);
    if (protectedPorts.has(port)) {
      args[0] = { ...first, host: '127.0.0.1', ipv6Only: false };
    }
  } else {
    const port = numericPort(first);
    if (protectedPorts.has(port)) {
      // listen(port[, host][, backlog][, callback])
      if (typeof args[1] === 'string') {
        args[1] = '127.0.0.1';
      } else {
        args.splice(1, 0, '127.0.0.1');
      }
    }
  }

  return originalListen.apply(this, args);
};
