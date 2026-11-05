import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { Transfer, CHUNK, MAX_SIZE, crc } from '../src/protocol.js';
const makeFile = (bytes, name = 'hello.bin') => ({ name, type: 'application/octet-stream', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });
function pair({ now } = {}) {
  const queue = []; let received, offers = 0;
  const sender = new Transfer({ now, emit: raw => queue.push([receiver, raw]) });
  const receiver = new Transfer({ now, emit: raw => queue.push([sender, raw]), offer: () => offers++, received: bytes => received = bytes });
  return { sender, receiver, queue, get received() { return received; }, get offers() { return offers; } };
}
async function flush(p) { for (let i = 0; p.queue.length && i < 1000; i++) { const [target, raw] = p.queue.shift(); await target.ingest(raw); } }
test('offer requires approval, then binary and empty files transfer and verify', async () => {
  for (const size of [0, 1, CHUNK, CHUNK + 1, 5133]) {
    const p = pair(), bytes = Uint8Array.from({ length: size }, (_, i) => i % 256);
    await p.sender.start(makeFile(bytes)); await flush(p);
    assert.equal(p.receiver.state, 'pending'); assert.equal(p.received, undefined);
    p.receiver.accept(); await flush(p);
    assert.equal(p.sender.state, 'complete'); assert.equal(p.receiver.state, 'complete'); assert.deepEqual(p.received, bytes);
  }
});
test('lost offer, acceptance, data, ACK, and DONE recover through QR repetition', async () => {
  let now = 0;
  const p = pair({ now: () => now }), bytes = Uint8Array.from({ length: 2400 }, (_, i) => i * 29 % 256);
  const dropped = new Set();
  await p.sender.start(makeFile(bytes));
  for (let tick = 0; tick < 100 && p.sender.state !== 'complete'; tick++) {
    while (p.queue.length) {
      const [target, raw] = p.queue.shift(), item = JSON.parse(raw);
      const key = `${item.type}:${item.index ?? item.next ?? ''}`;
      if (!dropped.has(key)) { dropped.add(key); continue; }
      await target.ingest(raw);
      if (p.receiver.state === 'pending') p.receiver.accept();
    }
    now += 11000; p.sender.tick(); p.receiver.tick();
  }
  assert.equal(p.sender.state, 'complete'); assert.deepEqual(p.received, bytes); assert.ok(p.sender.retries > 0);
});
test('corrupted packet is ignored and cannot advance receiver', async () => {
  const p = pair(); await p.sender.start(makeFile(new Uint8Array(800))); await flush(p);
  p.receiver.accept();
  await p.sender.ingest(p.queue.shift()[1]);
  const [, raw] = p.queue.shift(); const corrupted = JSON.parse(raw); corrupted.crc = 'bad';
  await p.receiver.ingest(JSON.stringify(corrupted)); assert.equal(p.receiver.next, 0);
  await p.receiver.ingest(raw); await flush(p); assert.equal(p.sender.state, 'complete');
});
test('duplicate offers prompt once, duplicate packets never duplicate output', async () => {
  const p = pair(); await p.sender.start(makeFile(new Uint8Array(800))); const offer = p.queue[0][1];
  await flush(p); await p.receiver.ingest(offer); assert.equal(p.offers, 1);
  p.receiver.accept(); await flush(p); const completed = p.received;
  await p.receiver.ingest(JSON.stringify({ ...p.sender.meta, v: 1, type: 'data', index: 0, data: '', crc: crc(new Uint8Array()) }));
  assert.equal(p.received, completed); assert.equal(p.receiver.parts.size, 3);
});
test('decline and cancel propagate to the other endpoint', async () => {
  for (const action of ['reject', 'cancel']) {
    const p = pair(); await p.sender.start(makeFile(new Uint8Array(800))); await flush(p);
    p.receiver[action](); await flush(p); assert.equal(p.sender.state, action === 'reject' ? 'rejected' : 'cancelled');
    assert.equal(p.received, undefined);
  }
});
test('untrusted offers and acknowledgments are bounded and session scoped', async () => {
  const p = pair();
  for (const input of ['not json', 'null', '{}', JSON.stringify({ v: 1, id: 'a', type: 'offer', size: MAX_SIZE + 1, count: 1, name: 'x', hash: 'a'.repeat(64), mime: '' })]) await p.receiver.ingest(input);
  assert.equal(p.receiver.state, 'idle');
  await assert.rejects(p.sender.start({ size: MAX_SIZE + 1 }), /5 MiB/);
  await p.sender.start(makeFile(new Uint8Array(800))); await flush(p);
  await p.sender.ingest(JSON.stringify({ v: 1, id: 'wrong', type: 'ack', next: 0 })); assert.equal(p.sender.state, 'offering');
  p.receiver.accept(); await p.sender.ingest(p.queue.shift()[1]);
  await p.sender.ingest(JSON.stringify({ v: 1, id: p.sender.meta.id, type: 'ack', next: 2 })); assert.equal(p.sender.next, 0);
});
test('whole-file SHA-256 catches content changes even with a valid packet CRC', async () => {
  const p = pair(); await p.sender.start(makeFile(new Uint8Array(1))); await flush(p); p.receiver.accept();
  await p.sender.ingest(p.queue.shift()[1]); const [, raw] = p.queue.shift(); const item = JSON.parse(raw);
  item.data = btoa('x'); item.crc = crc(new Uint8Array([120]));
  await p.receiver.ingest(JSON.stringify(item)); assert.equal(p.receiver.state, 'error'); assert.equal(p.received, undefined);
});
test('full QR packet encodes and decodes with the real QR libraries', async () => {
  const p = pair(); await p.sender.start(makeFile(new Uint8Array(CHUNK))); await flush(p); p.receiver.accept();
  await p.sender.ingest(p.queue.shift()[1]); const [, raw] = p.queue.shift();
  const qr = QRCode.create(raw, { errorCorrectionLevel: 'M' }); const scale = 6, margin = 4, width = (qr.modules.size + margin * 2) * scale;
  const rgba = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const row = Math.floor(y / scale) - margin, col = Math.floor(x / scale) - margin;
    if (row >= 0 && col >= 0 && row < qr.modules.size && col < qr.modules.size && qr.modules.get(row, col)) {
      const offset = (y * width + x) * 4; rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 0;
    }
  }
  const decoded = jsQR(rgba, width, width); assert.equal(decoded?.data, raw);
  await p.receiver.ingest(decoded.data); await flush(p); assert.equal(p.sender.state, 'complete');
});

test('QR timing adapts to actual acknowledgment latency and averages actual display intervals', async () => {
  let now = 0;
  const p = pair({ now: () => now });
  await p.sender.start(makeFile(new Uint8Array(CHUNK * 4))); await flush(p);
  assert.equal(p.sender.averageInterval, null);
  p.receiver.accept(); await p.sender.ingest(p.queue.shift()[1]);
  const first = p.queue.shift()[1];
  p.sender.markDisplayed(first);
  now = 400; await p.receiver.ingest(first);
  now = 800; await p.sender.ingest(p.queue.shift()[1]);
  assert.equal(p.sender.displayInterval, 280); assert.equal(p.sender.retryDelay, 2200);
  const second = p.queue.shift()[1]; p.sender.markDisplayed(second);
  assert.equal(p.sender.averageInterval, 800);
  // The same code being scanned/painted twice must not create fake timing samples.
  p.sender.markDisplayed(second); assert.equal(p.sender.intervalSamples, 1);
  now = 900; await p.receiver.ingest(second);
  assert.equal(p.receiver.averageInterval, 500);
  const samples = p.receiver.intervalSamples;
  await p.receiver.ingest(second); assert.equal(p.receiver.intervalSamples, samples);
  now = 1000; await p.sender.ingest(p.queue.shift()[1]);
  assert.ok(p.sender.displayInterval < 280); assert.ok(p.sender.retryDelay < 2200);
  const third = p.queue.pop()[1]; p.sender.markDisplayed(third);
  assert.equal(p.sender.averageInterval, 500);
  const hold = p.sender.displayInterval;
  // Invalid ACKs cannot change timing or advance the current packet.
  await p.sender.ingest(JSON.stringify({ v: 1, id: p.sender.meta.id, type: 'ack', next: 99 }));
  assert.equal(p.sender.displayInterval, hold);
  // An obsolete queued QR must not overwrite the actual packet's timestamp.
  now = 1200; p.sender.markDisplayed(first); assert.equal(p.sender.sentAt, 1000);
  p.sender.reset(); assert.equal(p.sender.averageInterval, null); assert.equal(p.sender.displayInterval, 300);
});

test('retry timing backs off during scan loss and remains bounded', async () => {
  let now = 0;
  const p = pair({ now: () => now });
  await p.sender.start(makeFile(new Uint8Array(CHUNK * 2))); await flush(p); p.receiver.accept();
  await p.sender.ingest(p.queue.shift()[1]);
  const first = p.queue.shift()[1]; p.sender.markDisplayed(first);
  now = 1799; p.sender.tick(); assert.equal(p.sender.retries, 0);
  now = 1800; p.sender.tick(); assert.equal(p.sender.retries, 1);
  now = 4499; p.sender.tick(); assert.equal(p.sender.retries, 1);
  now = 4500; p.sender.tick(); assert.equal(p.sender.retries, 2);
  // A very late acknowledgment slows the cadence without allowing unbounded waits.
  p.queue.length = 0; now = 90000; await p.receiver.ingest(first);
  await p.sender.ingest(p.queue.shift()[1]);
  assert.equal(p.sender.displayInterval, 1200); assert.equal(p.sender.retryDelay, 10000);
  assert.equal(p.sender.retryAttempts, 0);
});

test('simultaneous senders get a recoverable conflict instead of silently overwriting a file', async () => {
  let now = 0;
  const p = pair({ now: () => now });
  const bytes = new Uint8Array([1, 2, 3]);
  await p.sender.start(makeFile(bytes)); await p.receiver.start(makeFile(new Uint8Array([4]))); await flush(p);
  assert.equal(p.sender.state, 'offering'); assert.equal(p.receiver.state, 'offering');
  assert.equal(p.sender.conflictingOffer, true); assert.equal(p.receiver.conflictingOffer, true);
  p.receiver.cancel(); await flush(p); p.receiver.reset();
  now = 11000; p.sender.tick(); await flush(p); assert.equal(p.receiver.state, 'pending');
  p.receiver.accept(); await flush(p); assert.equal(p.sender.state, 'complete'); assert.deepEqual(p.received, bytes);
});
