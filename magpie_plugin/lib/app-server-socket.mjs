import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';

const MAX_MESSAGE = 32 * 1024 * 1024;
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function clientFrame(opcode, payload) {
  const size = payload.length;
  const prefix = size < 126 ? 2 : size <= 0xffff ? 4 : 10;
  const frame = Buffer.allocUnsafe(prefix + 4 + size);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | (prefix === 2 ? size : prefix === 4 ? 126 : 127);
  if (prefix === 4) frame.writeUInt16BE(size, 2);
  if (prefix === 10) frame.writeBigUInt64BE(BigInt(size), 2);
  const mask = randomBytes(4);
  mask.copy(frame, prefix);
  for (let offset = 0; offset < size; offset++) frame[prefix + 4 + offset] = payload[offset] ^ mask[offset % 4];
  return frame;
}

function upgrade(url, token, timeoutMs) {
  const key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, agent: false,
      headers: { Authorization: `Bearer ${token}`, Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    const timer = setTimeout(() => req.destroy(new Error('WebSocket upgrade timed out.')), timeoutMs);
    req.once('error', (error) => { clearTimeout(timer); reject(error); });
    req.once('response', (response) => {
      clearTimeout(timer);
      response.destroy();
      reject(new Error(`WebSocket upgrade failed (HTTP ${response.statusCode}).`));
    });
    req.once('upgrade', (response, socket, head) => {
      clearTimeout(timer);
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected
          || response.headers.upgrade?.toLowerCase() !== 'websocket'
          || response.headers['sec-websocket-extensions']) {
        socket.destroy();
        reject(new Error('Invalid WebSocket handshake.'));
        return;
      }
      socket.pause();
      resolve({ socket, head });
    });
    req.end();
  });
}

export async function openAppServerSocket(url, token, timeoutMs, onMessage, onDisconnect) {
  const { socket, head } = await upgrade(url, token, timeoutMs);
  let buffered = head;
  let fragments = [];
  let messageSize = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const send = (opcode, payload) => socket.write(clientFrame(opcode, payload));

  function consume(chunk) {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    try {
      while (buffered.length >= 2) {
        const first = buffered[0];
        const opcode = first & 0x0f;
        const final = Boolean(first & 0x80);
        const lengthCode = buffered[1];
        const prefix = lengthCode < 126 ? 2 : lengthCode === 126 ? 4 : 10;
        if ((first & 0x70) || lengthCode > 127) throw new Error('Invalid WebSocket frame.');
        if (buffered.length < prefix) return;
        const size = prefix === 2 ? lengthCode : prefix === 4
          ? buffered.readUInt16BE(2) : Number(buffered.readBigUInt64BE(2));
        if (size > MAX_MESSAGE || (opcode >= 8 && (!final || size > 125))) throw new Error('Invalid WebSocket frame length.');
        if (buffered.length < prefix + size) return;
        const payload = buffered.subarray(prefix, prefix + size);
        buffered = buffered.subarray(prefix + size);

        if (opcode === 8) {
          socket.end(clientFrame(8, payload));
          return;
        }
        if (opcode === 9) { send(10, payload); continue; }
        if (opcode === 10) continue;
        if (opcode !== (fragments.length ? 0 : 1)) throw new Error('Unexpected WebSocket opcode.');
        messageSize += size;
        if (messageSize > MAX_MESSAGE) throw new Error('WebSocket message is too large.');
        fragments.push(payload);
        if (final) {
          const message = decoder.decode(fragments.length === 1 ? payload : Buffer.concat(fragments, messageSize));
          fragments = [];
          messageSize = 0;
          onMessage(message);
        }
      }
    } catch (error) {
      socket.destroy(error);
    }
  }

  socket.setKeepAlive?.(true, 15_000);
  socket.setNoDelay?.(true);
  const pingTimer = setInterval(() => {
    if (!socket.destroyed && socket.writable) {
      try { send(9, Buffer.alloc(0)); } catch { /* Disconnect handler will fire. */ }
    }
  }, 20_000);
  pingTimer.unref?.();
  const stopPing = () => clearInterval(pingTimer);

  socket.on('data', consume);
  socket.on('error', (err) => { stopPing(); onDisconnect(err); });
  socket.once('close', () => { stopPing(); onDisconnect(new Error('Codex app-server closed the WebSocket.')); });
  setImmediate(() => {
    if (head.length) consume(Buffer.alloc(0));
    socket.resume();
  });
  return {
    send(text) { send(1, Buffer.from(text)); },
    close() { stopPing(); socket.destroy(); },
  };
}
