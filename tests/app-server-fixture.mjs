import { createHash } from 'node:crypto';

// Serve the small, unfragmented JSON-RPC messages used by the test app-server.
export function serveAppServerSocket(req, socket, onPacket) {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  function frame(opcode, body) {
    const header = body.length < 126 ? Buffer.from([0x80 | opcode, body.length])
      : Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255]);
    socket.write(Buffer.concat([header, body]));
  }
  const send = (data) => frame(1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...data })));
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15;
      let length = buffer[1] & 127;
      const offset = length === 126 ? 4 : 2;
      if (buffer.length < offset) return;
      if (offset === 4) length = buffer.readUInt16BE(2);
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const body = buffer.subarray(offset + 4, offset + 4 + length);
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 1) onPacket(JSON.parse(body.toString('utf8')), send);
      else if (opcode === 8) { frame(8, body); socket.end(); }
    }
  });
}
